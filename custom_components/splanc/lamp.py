"""One Splanc lamp's connection: the wss session, its state and its commands.

Kept free of Home Assistant imports so the session logic is easy to test.

Session etiquette (firmware/player_app/session_takeover.h, #444). A netstack
lamp serves ONE wss session. A session that sent no client message for 15 s
is idle, and a newcomer (usually the phone app) takes it over: the lamp closes
the old one with WS close code 4001. A busy session refuses the newcomer.

So this client is a polite background client:

- It never sends a message just to look busy (no heartbeat frames). It only
  sends when Home Assistant asks for something, so the phone always wins.
  Dead peers are noticed by TCP keepalive, not by pings.
- After a takeover (4001) it does not fight back. It waits 60 s, then 2 min,
  then up to 10 min (with jitter) before it tries again in the background.
  Until then the state is "assumed": the entities stay available, because a
  command reconnects on demand.
- A command reconnects at once (on demand). That only succeeds when the other
  client is idle, which is the right outcome.
- Every (re)connect resyncs with get_power and list_keypoints before it relies
  on pushes.
- Ordinary drops (Wi-Fi, reboot) retry after 1 s, doubling to 60 s.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import socket
import ssl
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from . import protocol as p

_LOGGER = logging.getLogger(__name__)

WS_CLOSE_TAKEN_OVER = 4001

CONNECT_TIMEOUT = 10.0
REQUEST_TIMEOUT = 6.0
# Ordinary drops.
RETRY_MIN = 1.0
RETRY_MAX = 60.0
# After a takeover (the phone app took the session).
TAKEOVER_RETRY_MIN = 60.0
TAKEOVER_RETRY_MAX = 600.0
# A session that lasted this long resets the backoff.
STABLE_SESSION_S = 120.0


class LampError(Exception):
    """A command could not be carried out."""


class CannotConnect(LampError):
    """The lamp did not answer (or refused: another client is busy with it)."""


class CertificateMismatch(LampError):
    """The lamp presented a different certificate than the pinned one."""

    def __init__(self, expected: str, got: str | None) -> None:
        super().__init__(
            f"certificate changed (pinned {expected[:16]}…, got {(got or 'none')[:16]}…)"
        )
        self.expected = expected
        self.got = got


class TakenOver(LampError):
    """Another client (the phone app) took the lamp's session over."""


def normalize_mac(mac: str) -> str:
    """'aa-bb-cc-dd-ee-ff' / 'aabbccddeeff' -> 'AA:BB:CC:DD:EE:FF'."""
    hexs = "".join(c for c in mac if c.isalnum()).upper()
    if len(hexs) != 12:
        return mac.upper()
    return ":".join(hexs[i : i + 2] for i in range(0, 12, 2))


def normalize_fingerprint(fp: str) -> str:
    return "".join(c for c in fp if c in "0123456789abcdefABCDEF").lower()


def _no_verify_context() -> ssl.SSLContext:
    # Each lamp has its own self-signed certificate: no CA can vouch for it, so
    # it is pinned by its SHA-256 instead (trust on first use).
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _ws_url(host: str) -> str:
    return f"wss://{host}/ws"


@dataclass
class LampInfo:
    """What a first connect learns (config flow)."""

    mac: str
    name: str
    fw_version: str
    features: list[str]
    fingerprint: str


@dataclass
class LampState:
    connected: bool = False
    # True while the session is released (taken over / down): values are the
    # last known, not live.
    assumed: bool = True
    welcome: p.Welcome | None = None
    power: p.PowerState | None = None
    brightness: float | None = None
    # Without the "power" feature: the brightness to come back to on "on".
    last_on_brightness: float = 1.0
    effect_id: str = ""
    keypoints: list[str] = field(default_factory=list)
    keypoint: str | None = None
    taken_over_at: float | None = None
    takeovers: int = 0
    reconnects: int = 0
    last_error: str | None = None

    @property
    def features(self) -> list[str]:
        return self.welcome.features if self.welcome else []

    @property
    def has_power(self) -> bool:
        return "power" in self.features

    @property
    def is_on(self) -> bool | None:
        if self.power is not None and self.has_power:
            return self.power.on
        if self.brightness is None:
            return None
        return self.brightness > 0


async def _open(
    session: aiohttp.ClientSession, host: str, pin: str | None
) -> tuple[aiohttp.ClientWebSocketResponse, str | None]:
    """Open wss://host/ws; returns the socket and the presented certificate's
    SHA-256. With `pin`, a different certificate raises CertificateMismatch."""
    try:
        ws = await session.ws_connect(
            _ws_url(host),
            ssl=_no_verify_context(),
            timeout=aiohttp.ClientWSTimeout(ws_close=2.0),
            autoping=True,
            heartbeat=None,
            max_msg_size=1 << 20,
        )
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as err:
        raise CannotConnect(str(err) or type(err).__name__) from err
    fp: str | None = None
    ssl_obj = ws.get_extra_info("ssl_object")
    if ssl_obj is not None:
        der = ssl_obj.getpeercert(binary_form=True)
        if der:
            fp = hashlib.sha256(der).hexdigest()
    if pin and fp != normalize_fingerprint(pin):
        await ws.close()
        raise CertificateMismatch(normalize_fingerprint(pin), fp)
    sock = ws.get_extra_info("socket")
    if sock is not None:
        _keepalive(sock)
    return ws, fp


def _keepalive(sock: socket.socket) -> None:
    """TCP keepalive notices a lamp that vanished (rebooted, left Wi-Fi) without
    us sending any WS frame (frames would keep the session busy)."""
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for opt, val in (("TCP_KEEPIDLE", 20), ("TCP_KEEPINTVL", 5), ("TCP_KEEPCNT", 3)):
            if hasattr(socket, opt):
                sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, opt), val)
    except OSError:
        pass


async def _await_welcome(ws: aiohttp.ClientWebSocketResponse, timeout: float) -> p.Welcome:
    async with asyncio.timeout(timeout):
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                arm, body = p.decode_server(msg.data)
                if arm == "welcome":
                    return body
                if arm == "error":
                    raise CannotConnect(f"lamp error {body.code}: {body.message}")
            elif msg.type in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSED,
                aiohttp.WSMsgType.ERROR,
            ):
                break
    if ws.close_code == WS_CLOSE_TAKEN_OVER:
        raise TakenOver("taken over by another client")
    raise CannotConnect("the lamp closed the connection before its welcome")


async def probe(
    session: aiohttp.ClientSession,
    host: str,
    *,
    client: str,
    app_version: str,
    pin: str | None = None,
    timeout: float = CONNECT_TIMEOUT,
) -> LampInfo:
    """Connect once, read the welcome and the certificate, disconnect (config flow)."""
    ws, fp = await _open(session, host, pin)
    try:
        await ws.send_bytes(p.hello(client, app_version))
        w = await _await_welcome(ws, timeout)
    except asyncio.TimeoutError as err:
        raise CannotConnect("no welcome from the lamp") from err
    finally:
        await ws.close()
    if not w.mac:
        raise CannotConnect("the lamp did not report its MAC (firmware too old)")
    return LampInfo(
        mac=normalize_mac(w.mac),
        name=w.device_name or w.mac,
        fw_version=w.fw_version,
        features=list(w.features),
        fingerprint=fp or "",
    )


class SplancLamp:
    """The long-lived connection to one lamp."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        pin: str,
        *,
        client: str = "home-assistant",
        app_version: str = "",
        mac: str = "",
        rand: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session = session
        self.host = host
        self.pin = normalize_fingerprint(pin)
        self.mac = normalize_mac(mac) if mac else ""
        self._client = client
        self._app_version = app_version
        self._rand = rand
        self._clock = clock
        self.state = LampState()
        self._listeners: list[Callable[[], None]] = []
        self._touch_listeners: list[Callable[[str, p.PowerState], None]] = []
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader: asyncio.Task[None] | None = None
        self._loop_task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._connect_lock = asyncio.Lock()
        self._request_lock = asyncio.Lock()
        self._waiters: list[tuple[set[str], asyncio.Future[Any]]] = []
        self._stopped = False
        self._retry = RETRY_MIN
        self._takeover_retry = TAKEOVER_RETRY_MIN
        self.cert_mismatch: CertificateMismatch | None = None
        self.on_cert_mismatch: Callable[[CertificateMismatch], None] | None = None

    # -- listeners ------------------------------------------------------------

    def add_listener(self, fn: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def add_touch_listener(self, fn: Callable[[str, p.PowerState], None]) -> Callable[[], None]:
        self._touch_listeners.append(fn)
        return lambda: self._touch_listeners.remove(fn)

    def _notify(self) -> None:
        for fn in list(self._listeners):
            fn()

    # -- lifecycle --------------------------------------------------------------

    async def start(self) -> None:
        """Connect now (raise CannotConnect / CertificateMismatch / TakenOver if
        that fails), then keep the session in the background."""
        try:
            await self.connect()
        except TakenOver:
            pass  # released at once: keep going in the background, commands reconnect
        self.start_background()

    def start_background(self) -> None:
        """Keep the session in the background (no first connect)."""
        if self._loop_task is None:
            self._loop_task = asyncio.get_running_loop().create_task(
                self._run(), name=f"splanc {self.host}"
            )

    async def stop(self) -> None:
        self._stopped = True
        self._wake.set()
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._close_ws()

    async def _close_ws(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None and not ws.closed:
            await ws.close()
        if self._reader and self._reader is not asyncio.current_task():
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._reader = None

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed and self.state.connected

    async def _run(self) -> None:
        """Background (re)connect loop."""
        while not self._stopped:
            if self.connected:
                self._wake.clear()
                await self._wake.wait()
                continue
            if self.cert_mismatch is not None:
                return  # needs the user (reauth); a reload restarts us
            taken = self.state.taken_over_at is not None
            delay = self._takeover_retry if taken else self._retry
            delay *= 0.8 + 0.4 * self._rand()
            self._wake.clear()
            try:
                async with asyncio.timeout(delay):
                    await self._wake.wait()
            except TimeoutError:
                pass
            if self._stopped or self.connected:
                continue
            try:
                await self.connect()
            except CertificateMismatch:
                return
            except TakenOver:
                pass
            except LampError as err:
                self.state.last_error = str(err)
                if taken:
                    self._takeover_retry = min(self._takeover_retry * 2, TAKEOVER_RETRY_MAX)
                else:
                    self._retry = min(self._retry * 2, RETRY_MAX)

    async def connect(self) -> None:
        """Open the session (if not open), hello, then resync. On demand: a
        command calls this when the session is released."""
        async with self._connect_lock:
            if self.connected:
                return
            await self._close_ws()
            try:
                ws, _fp = await _open(self._session, self.host, self.pin)
            except CertificateMismatch as err:
                self._cert_mismatch(err)
                raise
            try:
                await ws.send_bytes(p.hello(self._client, self._app_version))
                welcome = await _await_welcome(ws, CONNECT_TIMEOUT)
            except TakenOver:
                await ws.close()
                raise
            except (asyncio.TimeoutError, aiohttp.ClientError, p.DecodeError) as err:
                await ws.close()
                raise CannotConnect(
                    f"no welcome from the lamp ({err or type(err).__name__})"
                ) from err
            except CannotConnect:
                await ws.close()
                raise
            got_mac = normalize_mac(welcome.mac) if welcome.mac else ""
            if self.mac and got_mac and got_mac != self.mac:
                await ws.close()
                raise CannotConnect(f"another lamp ({got_mac}) answers at {self.host}")
            self._ws = ws
            self.state.welcome = welcome
            self.state.connected = True
            self.state.reconnects += 1
            if welcome.brightness is not None:
                self._set_brightness_state(welcome.brightness)
            self._opened_at = self._clock()
            self._reader = asyncio.get_running_loop().create_task(
                self._read(ws), name=f"splanc rx {self.host}"
            )
        await self._resync()
        self.state.assumed = False
        self.state.taken_over_at = None
        self.state.last_error = None
        self._retry = RETRY_MIN
        self._takeover_retry = TAKEOVER_RETRY_MIN
        self._notify()

    async def _resync(self) -> None:
        """get_power + list_keypoints, so state is right before relying on pushes.
        get_power also subscribes: the lamp pushes power_state only to sessions
        that sent a power arm since they connected."""
        if self.state.has_power:
            try:
                await self._request(p.get_power(), {"power_state"})
            except LampError as err:
                _LOGGER.debug("%s: get_power failed: %s", self.host, err)
        await self._refresh_keypoints()

    async def _refresh_keypoints(self) -> None:
        if "keypoints" not in self.state.features:
            self.state.keypoints = []
            return
        try:
            kl: p.KeypointList = await self._request(p.list_keypoints(0), {"keypoint_list"})
        except LampError as err:
            _LOGGER.debug("%s: list_keypoints failed: %s", self.host, err)
            return
        self._apply_keypoints(kl)

    def _apply_keypoints(self, kl: p.KeypointList) -> None:
        if kl.deck != 0:
            return
        if kl.effect_id and kl.effect_id != self.state.effect_id:
            self.state.keypoint = None
            self.state.effect_id = kl.effect_id
        self.state.keypoints = list(kl.names)

    def _cert_mismatch(self, err: CertificateMismatch) -> None:
        self.cert_mismatch = err
        self.state.last_error = str(err)
        _LOGGER.warning(
            "%s: %s; not connecting until you confirm the new certificate", self.host, err
        )
        if self.on_cert_mismatch:
            self.on_cert_mismatch(err)
        self._notify()

    # -- receive ----------------------------------------------------------------

    async def _read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    try:
                        arm, body = p.decode_server(msg.data)
                    except p.DecodeError as err:
                        _LOGGER.debug("%s: undecodable frame: %s", self.host, err)
                        continue
                    self._dispatch(arm, body)
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
        except (aiohttp.ClientError, OSError) as err:
            _LOGGER.debug("%s: receive failed: %s", self.host, err)
        finally:
            if self._ws is ws:
                self._on_closed(ws.close_code)

    def _on_closed(self, code: int | None) -> None:
        self._ws = None
        self.state.connected = False
        self.state.assumed = True
        err: LampError
        if code == WS_CLOSE_TAKEN_OVER:
            self.state.takeovers += 1
            if self.state.taken_over_at is None:
                _LOGGER.info(
                    "%s: another client (the Splanc app?) took the lamp's connection; "
                    "Home Assistant reconnects in the background or on your next command",
                    self.host,
                )
            self.state.taken_over_at = self._clock()
            err = TakenOver("taken over by another client")
        else:
            lived = self._clock() - getattr(self, "_opened_at", self._clock())
            if lived >= STABLE_SESSION_S:
                self._retry = RETRY_MIN
            err = CannotConnect("the lamp closed the connection")
        for _types, fut in self._waiters:
            if not fut.done():
                fut.set_exception(err)
        self._waiters.clear()
        self._notify()
        self._wake.set()

    def _dispatch(self, arm: str, body: Any) -> None:
        changed = False
        if arm == "power_state":
            changed = self._apply_power(body)
        elif arm == "keypoint_list":
            self._apply_keypoints(body)
            changed = True
        elif arm == "welcome":
            self.state.welcome = body
            if body.brightness is not None:
                self._set_brightness_state(body.brightness)
            changed = True
        elif arm == "playback_state":
            changed = True
        for i, (types, fut) in enumerate(self._waiters):
            if fut.done():
                continue
            if arm in types:
                fut.set_result(body)
                del self._waiters[i]
                break
            if arm == "error":
                fut.set_exception(LampError(f"lamp error {body.code}: {body.message}".strip()))
                del self._waiters[i]
                break
        if changed:
            self._notify()

    def _apply_power(self, ps: p.PowerState) -> bool:
        prev = self.state.power
        # seq increases on every change: drop a stale push (it wraps at 2^32).
        if (
            prev is not None
            and ps.seq
            and prev.seq
            and ((ps.seq - prev.seq) & 0xFFFFFFFF) > 0x7FFFFFFF
        ):
            return False
        self.state.power = ps
        self._set_brightness_state(ps.brightness)
        if ps.effect_id != self.state.effect_id:
            self.state.effect_id = ps.effect_id
            self.state.keypoint = None
            self.state.keypoints = []
            if self.connected:
                asyncio.get_running_loop().create_task(self._refresh_and_notify())
        # The toggle trigger (a lid tap) fired since the last state we saw. A
        # reboot resets the counter: only count increases.
        if (
            prev is not None
            and ps.trigger_count > prev.trigger_count
            and ps.source == p.SOURCE_TRIGGER
        ):
            for fn in list(self._touch_listeners):
                fn("tap", ps)
        return True

    async def _refresh_and_notify(self) -> None:
        await self._refresh_keypoints()
        self._notify()

    def _set_brightness_state(self, b: float) -> None:
        self.state.brightness = b
        if b > 0:
            self.state.last_on_brightness = b

    # -- requests ---------------------------------------------------------------

    async def _request(
        self, frame: bytes, reply: set[str], timeout: float = REQUEST_TIMEOUT
    ) -> Any:
        """Send one frame and wait for the first reply of a type in `reply`
        (the protocol has no request ids: replies come back in order)."""
        async with self._request_lock:
            ws = self._ws
            if ws is None or ws.closed:
                raise CannotConnect("not connected")
            fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
            self._waiters.append((reply, fut))
            try:
                await ws.send_bytes(frame)
                async with asyncio.timeout(timeout):
                    return await fut
            except TimeoutError as err:
                raise LampError("the lamp did not answer") from err
            except (aiohttp.ClientError, ConnectionResetError) as err:
                raise CannotConnect(str(err)) from err
            finally:
                self._waiters = [(t, f) for t, f in self._waiters if f is not fut]

    async def _command(self, frame: bytes, reply: set[str]) -> Any:
        """A user command: reconnect on demand when released, then send it."""
        if self.cert_mismatch is not None:
            raise self.cert_mismatch
        if not self.connected:
            await self.connect()
        return await self._request(frame, reply)

    async def set_power(self, on: bool, *, duration_ms: int = 0, instant: bool = False) -> None:
        if self.cert_mismatch is not None:
            raise self.cert_mismatch
        if not self.connected:
            await self.connect()
        if not self.state.has_power:
            # Older firmware: off = brightness 0, on = the last brightness.
            await self.set_brightness(self.state.last_on_brightness if on else 0.0, remember=False)
            return
        await self._command(
            p.set_power(on, instant=instant, duration_ms=duration_ms), {"power_state"}
        )

    async def set_brightness(self, brightness: float, *, remember: bool = True) -> None:
        b = min(1.0, max(0.0, brightness))
        await self._command(p.set_brightness(b), {"welcome"})
        if remember and b > 0:
            self.state.last_on_brightness = b
        self._set_brightness_state(b)
        self._notify()

    async def recall_keypoint(self, name: str, seconds: float = 0.5) -> None:
        await self._command(p.blend_keypoints({name: 1.0}, seconds), {"playback_state"})
        self.state.keypoint = name
        self._notify()

    def diagnostics(self) -> dict[str, Any]:
        s = self.state
        w = s.welcome
        return {
            "host": self.host,
            "connected": self.connected,
            "assumed_state": s.assumed,
            "pinned_cert_sha256": self.pin,
            "certificate_mismatch": str(self.cert_mismatch) if self.cert_mismatch else None,
            "firmware": w.fw_version if w else None,
            "features": list(s.features),
            "power_supported": s.has_power,
            "on_off_mode": "set_power" if s.has_power else "brightness (firmware without power)",
            "power": vars(s.power) if s.power else None,
            "brightness": s.brightness,
            "effect_id": s.effect_id,
            "keypoints": list(s.keypoints),
            "takeovers": s.takeovers,
            "connects": s.reconnects,
            "last_error": s.last_error,
        }
