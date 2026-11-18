"""A mock splanc device over WebSocket — a self-contained backend for the phone
HITL journeys, so connect / config / mapping run in-container with no rig.

Speaks the ledmapper.v1 wire via the SAME codec the real Pi server uses
(pi/server proto_wire: decode_client / encode_server), replying to exactly the
messages the three journeys drive:

  hello               -> welcome (mac, deviceName, codeParams)
  time_sync_ping      -> time_sync_pong
  get_hardware_config -> hardware_config_state
  set_hardware_config -> hardware_config_state (echoes the set fields)
  set_color_correction-> welcome (the app awaits a welcome ack)
  start_mapping       -> mapping_started     (honours the requested syncPattern)
  configure           -> pattern_state       (mid-capture renegotiation: new code
                                              book + RESTAMPED epoch, as firmware does)
  stop_mapping        -> result_ready         (canned map id — the mapping FLOW is
  submit_map/topology -> result_ready          what this validates; solve correctness
  upload_chunk        -> chunk_ack / result_ready  is covered by pipeline_synthetic.test.ts)
  get_status/live_map -> status / minimal reply
  detections/imu/...  -> (no reply)

Firmware-only messages (set_hardware_config / set_color_correction) that the real
Pi reconstruction server does NOT implement are handled here so the config journey
can run without a real ESP32-C6; point --device-ws at a rig C6 to exercise the real
firmware instead.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import websockets
from server import proto_wire
from server.codebook import code_params_for

# What the C6/P4 firmware advertises in welcome.features (firmware/player
# FEATURE_STAGGER_PILOT): the app then asks start_mapping for hue code v2.
# MOCK_DEVICE_FEATURES=<comma list> overrides it ("" = an older player: v1 only).
FEATURES = (
    [f for f in os.environ["MOCK_DEVICE_FEATURES"].split(",") if f]
    if "MOCK_DEVICE_FEATURES" in os.environ
    else ["hue_stagger_pilot"]
)

CODE_PARAMS = {
    "ledCount": 64,
    "bits": 12,
    "encoding": "hue",
    "symbols": 2,
    "bitPeriodMs": 100.0,
    "syncPattern": "on_off",
    "cycleFrames": 14,
    "fec": "secded",
}


def _now_ms() -> float:
    return time.monotonic() * 1000.0


class MockDevice:
    """One mock device; serve() runs a WS server that any number of apps connect to."""

    def __init__(
        self,
        mac: str = "AA:BB:CC:DD:EE:FF",
        name: str = "Mock Widget 00FFEE",
        features: list[str] | None = None,
    ) -> None:
        self.mac = mac
        self.name = name
        self.features = list(FEATURES if features is None else features)
        self._led_count = CODE_PARAMS["ledCount"]
        # The active capture's code book (None = idle), for configure.
        self._active: dict[str, Any] | None = None
        self.reconfigures = 0

    def _welcome(self) -> dict[str, Any]:
        return {
            "type": "welcome",
            "sessionId": "mock",
            "codeParams": {**CODE_PARAMS, "ledCount": self._led_count},
            "solverBenchMs": None,
            "mac": self.mac,
            "deviceName": self.name,
            "fwGitCommit": "",
            "fwGitDirty": False,
            "features": self.features,
        }

    def _hardware_state(self, ch: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": "hardware_config_state",
            "channels": [
                {
                    "channel": int(ch.get("channel", 0)),
                    "gpio": int(ch.get("gpio", 8)),
                    "ledType": str(ch.get("ledType", "ws281x")),
                    "colorOrder": str(ch.get("colorOrder", "GRB")),
                }
            ],
        }

    def reply(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        """Map one decoded client message to a reply flat (or None for no reply)."""
        kind = msg.get("type")
        if kind == "hello":
            return self._welcome()
        if kind == "time_sync_ping":
            now = _now_ms()
            return {"type": "time_sync_pong", "t0": msg.get("t0", 0.0), "t1": now, "t2": now}
        if kind == "get_hardware_config":
            return self._hardware_state({})
        if kind == "set_hardware_config":
            return self._hardware_state(msg)
        if kind == "set_color_correction":
            return self._welcome()
        if kind == "start_mapping":
            opts = msg.get("options") or {}
            if opts.get("ledCount"):
                self._led_count = int(opts["ledCount"])
            # Like firmware: the requested sync pattern runs only if advertised.
            sync = opts.get("syncPattern") or "on_off"
            if sync == "stagger_pilot" and "hue_stagger_pilot" not in self.features:
                sync = "on_off"
            self._active = _code_params(
                self._led_count,
                opts.get("bitPeriodMs") or CODE_PARAMS["bitPeriodMs"],
                opts.get("symbols") or CODE_PARAMS["symbols"],
                opts.get("brightness"),
                sync,
            )
            return {
                "type": "mapping_started",
                "patternClockEpoch": _now_ms(),
                "codeParams": self._active,
            }
        if kind == "configure":
            # Mid-capture renegotiation (exposure/alphabet/brightness servos): the
            # firmware overlays the options on the active code book, keeps its sync
            # pattern and RESTAMPS the pattern epoch (firmware/player configure).
            if self._active is None:
                return {"type": "error", "code": "no_session", "message": "no active capture"}
            opts = msg.get("options") or {}
            cur = self._active
            if opts.get("ledCount"):
                self._led_count = int(opts["ledCount"])
            self._active = _code_params(
                self._led_count,
                opts.get("bitPeriodMs") or cur["bitPeriodMs"],
                opts.get("symbols") or cur["symbols"],
                opts["brightness"] if opts.get("brightness") is not None else cur.get("brightness"),
                cur["syncPattern"],
            )
            self.reconfigures += 1
            print(
                f"[mock] configure #{self.reconfigures} {opts} -> "
                f"symbols={self._active['symbols']} bitPeriodMs={self._active['bitPeriodMs']} "
                f"sync={self._active['syncPattern']} (epoch restamped)",
                file=sys.stderr,
                flush=True,
            )
            return {
                "type": "pattern_state",
                "active": True,
                "patternClockEpoch": _now_ms(),
                "codeParams": self._active,
            }
        if kind == "get_status":
            return {"type": "status", "identified": 0, "total": self._led_count, "lowParallax": 0}
        if kind == "stop_mapping":
            # The phone-solve path stops with solveOnHost=false and awaits a
            # `mapping_stopped` ack (it then solves locally + submits the map);
            # the host-solve path awaits `result_ready`. Reply to match, or the
            # app hangs waiting for the wrong message.
            self._active = None
            if msg.get("solveOnHost") is False:
                return {"type": "mapping_stopped", "detections": 0, "imuSamples": 0}
            return {"type": "result_ready", "mapId": "mock-map"}
        if kind in ("submit_map", "submit_topology"):
            return {"type": "result_ready", "mapId": "mock-map"}
        if kind == "upload_chunk":
            if msg.get("last"):
                return {"type": "result_ready", "mapId": "mock-map"}
            return {"type": "chunk_ack", "uploadId": msg.get("uploadId"), "seq": msg.get("seq")}
        # detections / imu_batch / exposure_report / configure / get_live_map /
        # set_playback / … — best-effort no-reply (the journeys we run don't block on them).
        return None


def _code_params(
    led_count: int, bit_period_ms: float, symbols: int, brightness: float | None, sync: str
) -> dict[str, Any]:
    """The code book a player derives (the shared kernel, via the Pi codebook)."""
    cp = code_params_for(
        led_count,
        float(bit_period_ms),
        int(symbols),
        brightness=brightness,
        sync_pattern=sync,
    )
    out = cp.model_dump(mode="json", exclude_none=True)
    return out


async def _handler(dev: MockDevice, ws: "websockets.WebSocketServerProtocol") -> None:
    async for raw in ws:
        try:
            msg = proto_wire.decode_client(bytes(raw))
        except Exception:  # noqa: BLE001 — ignore undecodable frames, keep the socket up
            continue
        reply = dev.reply(msg)
        if reply is not None:
            await ws.send(proto_wire.encode_server(reply))


class MockDeviceServer:
    """Async context manager: run the mock on `port`; `url` is the ws:// the app dials."""

    def __init__(self, port: int = 0, host: str = "127.0.0.1") -> None:
        self._host = host
        self._port = port
        self._server: Any = None
        self.device = MockDevice()
        self.url = ""

    async def __aenter__(self) -> "MockDeviceServer":
        self._server = await websockets.serve(
            lambda ws: _handler(self.device, ws), self._host, self._port
        )
        port = self._server.sockets[0].getsockname()[1]
        self.url = f"ws://{self._host}:{port}/ws"
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
