"""WebSocket message handling (design doc §7 contract).

`ConnectionHandler` is created once per WebSocket connection and translates each
client message (§7.1) into zero or more server messages (§7.2). It is
transport-agnostic — it takes a raw text frame and returns a list of pydantic
server-message models — so the full control plane can be unit-tested without a
socket. The FastAPI layer (`app.py`) owns accept/receive/send and clock
timestamping; everything else lives here.
"""

from __future__ import annotations

from typing import Awaitable, Callable, List

from pydantic import ValidationError

from ledmapper_protocol import (
    ClientMessage,
    ErrorMessage,
    LiveMapMessage,
    MappingStartedMessage,
    OutputMap,
    PatternStateMessage,
    ResultReadyMessage,
    ServerMessage,
    SolveStatusMessage,
    StatusMessage,
    TimeSyncPongMessage,
    WelcomeMessage,
)

from .clock import now_ms
from .codebook import DEFAULT_BIT_PERIOD_MS, code_params_for
from .reconstruct import LiveSolver
from .session import SessionManager

# A reconstruction job: session log path -> OutputMap (see reconstruct.py).
Reconstructor = Callable[..., Awaitable[OutputMap]]


class ServerContext:
    """Shared, connection-independent server state."""

    def __init__(
        self,
        sessions: SessionManager,
        reconstructor: Reconstructor,
        *,
        default_led_count: int = 1024,
        bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
        id_factory: Callable[[], str] | None = None,
        clock: Callable[[], float] = now_ms,
        live_solver: LiveSolver | None = None,
        encoding: str = "gray",
    ):
        self.sessions = sessions
        self.reconstructor = reconstructor
        self.encoding = encoding
        self.live = live_solver if live_solver is not None else LiveSolver()
        self.default_led_count = default_led_count
        self.bit_period_ms = bit_period_ms
        self.clock = clock
        if id_factory is None:
            import uuid

            id_factory = lambda: str(uuid.uuid4())  # noqa: E731
        self.id_factory = id_factory


class ConnectionHandler:
    """Per-connection message dispatcher."""

    def __init__(self, ctx: ServerContext):
        self.ctx = ctx
        self.session_id = ctx.id_factory()
        self._capture_seq = 0

    async def handle(self, raw: str, *, recv_ms: float | None = None) -> List[ServerMessage]:
        """Parse one client frame and return the server responses to send.

        ``recv_ms`` is the server-clock receive time, captured by the transport
        as early as possible for accurate clock sync; if omitted it is sampled
        here.
        """
        if recv_ms is None:
            recv_ms = self.ctx.clock()
        try:
            msg = ClientMessage.model_validate_json(raw).root
        except ValidationError as exc:
            return [_error("bad_message", _first_error(exc))]

        kind = msg.type
        if kind == "hello":
            return [self._welcome()]
        if kind == "time_sync_ping":
            # t1 = receive time, t2 = send time (design doc §7.3).
            return [TimeSyncPongMessage(type="time_sync_pong", t0=msg.t0, t1=recv_ms, t2=self.ctx.clock())]
        if kind == "start_mapping":
            return [self._start(msg.options)]
        if kind == "configure":
            return [self._configure(msg.options)]
        if kind == "detections":
            return self._detections(msg.batch)
        if kind == "exposure_report":
            # Telemetry: best-effort append, no reply (like detections).
            self.ctx.sessions.add_exposure(msg.report)
            return []
        if kind == "imu_batch":
            # WebXR-free capture path (docs/vio-exploration.md): inertial
            # stream for the joint pose+LED solve. Best-effort, no reply.
            self.ctx.sessions.add_imu(msg.samples)
            return []
        if kind == "get_status":
            return [self._status()]
        if kind == "get_pattern":
            return [self._pattern()]
        if kind == "get_live_map":
            return [self._live_map()]
        if kind == "get_solve_status":
            return [self._solve_status()]
        if kind == "stop_mapping":
            return await self._stop()
        # ClientMessage's discriminated union makes this unreachable, but be loud.
        return [_error("unknown_type", f"unhandled message type {kind!r}")]

    # -- handlers ---------------------------------------------------------

    def _welcome(self) -> ServerMessage:
        # ledCount is not known until start_mapping, so welcome carries the
        # server's default code-book; mapping_started carries the actual one.
        return WelcomeMessage(
            type="welcome",
            sessionId=self.session_id,
            codeParams=code_params_for(self.ctx.default_led_count, self.ctx.bit_period_ms, self.ctx.encoding),
        )

    def _start(self, options) -> ServerMessage:
        # One connection can run several captures; each needs its own log id
        # or the later capture's log OVERWRITES the earlier one on disk. The
        # first capture keeps the bare connection id (the common case).
        self._capture_seq += 1
        capture_id = (
            self.session_id
            if self._capture_seq == 1
            else f"{self.session_id}-{self._capture_seq}"
        )
        # The client is the configuration authority (it measured the scene);
        # the ctx values are only the fallback for clients that send bare
        # options — the server needs no CLI flags to run any encoding/rate.
        params = code_params_for(
            options.ledCount,
            options.bitPeriodMs if options.bitPeriodMs is not None else self.ctx.bit_period_ms,
            options.encoding if options.encoding is not None else self.ctx.encoding,
        )
        epoch = self.ctx.sessions.start(capture_id, params)
        return MappingStartedMessage(
            type="mapping_started",
            patternClockEpoch=epoch,
            codeParams=params,
        )

    def _configure(self, options) -> ServerMessage:
        """Mid-capture renegotiation: overlay the given fields on the active
        capture's params, restamp the epoch (sessions.reconfigure), and reply
        pattern_state. Detections already collected are preserved."""
        state = self.ctx.sessions.pattern_state()
        if state is None:
            return _error("no_session", "configure requires an active capture session")
        _epoch, current = state
        params = code_params_for(
            options.ledCount if options.ledCount is not None else current.ledCount,
            options.bitPeriodMs if options.bitPeriodMs is not None else current.bitPeriodMs,
            options.encoding if options.encoding is not None else current.encoding,
        )
        epoch = self.ctx.sessions.reconfigure(params)
        return PatternStateMessage(
            type="pattern_state",
            active=True,
            patternClockEpoch=epoch,
            codeParams=params,
        )

    def _detections(self, batch) -> List[ServerMessage]:
        try:
            self.ctx.sessions.add_detections(batch)
        except RuntimeError as exc:
            return [_error("no_session", str(exc))]
        # The contract has no per-batch ack; the client polls get_status.
        return []

    def _status(self) -> ServerMessage:
        identified, total, low = self.ctx.sessions.status()
        return StatusMessage(type="status", identified=identified, total=total, lowParallax=low)

    def _pattern(self) -> ServerMessage:
        """Pattern-clock state for followers (the virtual LED wall test page).

        When a capture is active the codeParams reflect its ledCount, so a wall
        adopts the phone's LED count automatically; when idle it gets the server
        default so it can lay out its grid before mapping starts.
        """
        state = self.ctx.sessions.pattern_state()
        if state is None:
            return PatternStateMessage(
                type="pattern_state",
                active=False,
                patternClockEpoch=None,
                codeParams=code_params_for(self.ctx.default_led_count, self.ctx.bit_period_ms, self.ctx.encoding),
            )
        epoch, params = state
        return PatternStateMessage(
            type="pattern_state",
            active=True,
            patternClockEpoch=epoch,
            codeParams=params,
        )

    def _solve_status(self) -> ServerMessage:
        """Final-solve progress (§7 solve_status): served from the
        ReconstructionRunner's poll-visible snapshot. Falls back to inactive
        for reconstructors without one (test stubs, exotic wiring)."""
        status = getattr(self.ctx.reconstructor, "status", None) or {}
        return SolveStatusMessage(
            type="solve_status",
            running=bool(status.get("running", False)),
            progress=status.get("progress"),
            rmsPx=status.get("rmsPx"),
            leds=status.get("leds"),
            trajectory=status.get("trajectory"),
        )

    def _live_map(self) -> ServerMessage:
        """Latest interim reconstruction; polling drives the continuous solver."""
        active, interim = self.ctx.live.poll(self.ctx.sessions)
        return LiveMapMessage(type="live_map", active=active, map=interim)

    async def _stop(self) -> List[ServerMessage]:
        try:
            _session_id, log_path = self.ctx.sessions.stop()
        except RuntimeError as exc:
            return [_error("no_session", str(exc))]
        try:
            output_map = await self.ctx.reconstructor(log_path)
        except Exception as exc:  # reconstruction is best-effort; report, don't crash
            return [_error("reconstruction_failed", f"{type(exc).__name__}: {exc}")]
        return [ResultReadyMessage(type="result_ready", mapId=output_map.mapId)]


def _error(code: str, message: str) -> ServerMessage:
    return ErrorMessage(type="error", code=code, message=message)


def _first_error(exc: ValidationError) -> str:
    errs = exc.errors()
    if not errs:
        return "invalid message"
    e = errs[0]
    loc = ".".join(str(p) for p in e.get("loc", ()))
    return f"{loc}: {e.get('msg', 'invalid')}" if loc else e.get("msg", "invalid")
