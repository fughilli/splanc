"""Bench probe for a player's WebSocket protocol endpoint (no phone needed).

Drives the ledmapper.v1 wire against any player — the ESP32 bring-up app
(plain ws://, port 81) or the Pi server — using the same Python protocol
stack the golden frames are generated with:

    bazelisk run //tools:player_probe -- ws://192.168.4.1:81/ws
    bazelisk run //tools:player_probe -- ws://192.168.4.1:81/ws --leds 64 --run-seconds 20
    bazelisk run //tools:player_probe -- wss://localhost:8443/ws --profile pi --insecure

Sequence: hello -> time sync x3 -> start_mapping (the strip should start
the hue cycle) -> hold -> counting pattern (red/blue halves) -> clear ->
set_led_count -> a small submit_map + submit_topology (arena path) ->
playback probe -> stop. Every reply is decoded and contract-checked; exit
code 0 means the player upheld the protocol.
"""

from __future__ import annotations

import argparse
import asyncio
import ssl
import sys
import time

import websockets
from server import proto_wire


class Probe:
    def __init__(self, sock):
        self.sock = sock
        self.failures: list[str] = []

    async def send(self, flat: dict, expect: str | None, note: str = "") -> dict | None:
        await self.sock.send(proto_wire.encode_client(flat))
        if expect is None:
            return None
        raw = await asyncio.wait_for(self.sock.recv(), timeout=5.0)
        reply = proto_wire.decode_server(raw)
        tag = f"{flat['type']}{' (' + note + ')' if note else ''}"
        if reply["type"] != expect:
            self.failures.append(f"{tag}: expected {expect}, got {reply}")
            print(f"  FAIL {tag}: {reply}")
        else:
            print(f"  ok   {tag} -> {reply['type']}")
        return reply

    def check(self, cond: bool, what: str) -> None:
        if not cond:
            self.failures.append(what)
            print(f"  FAIL {what}")


async def run(url: str, leds: int, run_seconds: float, profile: str, insecure: bool) -> int:
    print(f"connecting {url} ({profile} profile)")
    ssl_ctx = None
    if url.startswith("wss:") and insecure:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
    async with websockets.connect(url, max_size=2**22, ssl=ssl_ctx) as sock:
        p = Probe(sock)

        welcome = await p.send(
            {"type": "hello", "client": "player-probe", "appVersion": "0"}, "welcome"
        )
        if profile == "esp32":
            p.check(
                welcome.get("solverBenchMs") is None,
                "a solverless player must not advertise a solver bench",
            )

        # Clock sync: offset = ((t1 - t0) + (t2 - t3)) / 2 (§7.3).
        offsets = []
        for _ in range(3):
            t0 = time.monotonic() * 1000.0
            pong = await p.send({"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
            t3 = time.monotonic() * 1000.0
            offsets.append(((pong["t1"] - t0) + (pong["t2"] - t3)) / 2)
        print(f"  clock offset ~{sum(offsets) / len(offsets):.1f} ms (player - local)")

        started = await p.send(
            {"type": "start_mapping", "options": {"ledCount": leds}}, "mapping_started"
        )
        cp = started["codeParams"]
        p.check(cp["ledCount"] == leds, f"codeParams.ledCount {cp['ledCount']} != {leds}")
        p.check(cp["encoding"] == "hue", "encoding must be hue")
        print(
            f"  pattern running: {cp['bits']} bits, {cp['cycleFrames']} frames @ "
            f"{cp['bitPeriodMs']} ms — watch the strip cycle white/green + colors"
        )
        await asyncio.sleep(run_seconds)

        state = await p.send({"type": "get_pattern"}, "pattern_state")
        p.check(state["active"] is True, "pattern_state.active during capture")

        print("  counting: red lower half / blue upper half — check the strip")
        await p.send(
            {
                "type": "set_counting_pattern",
                "blocks": [
                    {"start": 0, "count": leds // 2, "rgb": [1, 0, 0]},
                    {"start": leds // 2, "count": leds, "rgb": [0, 0, 1]},
                ],
            },
            "counting_state",
        )
        await asyncio.sleep(3.0)
        await p.send({"type": "set_counting_pattern", "blocks": []}, "counting_state", "clear")
        await p.send({"type": "set_led_count", "ledCount": leds}, "led_count_state")

        # Uploads (the arena path on the ESP32).
        the_map = {
            "mapId": "probe-map",
            "createdAt": "2026-01-01T00:00:00Z",
            "units": "meters",
            "frame": "gravity_leveled",
            "ledCount": leds,
            "leds": [
                {
                    "id": i,
                    "xyz": [i * 0.01, 0.0, 0.0],
                    "confidence": 0.9,
                    "nViews": 4,
                    "rmsReprojPx": 0.5,
                    "parallaxDeg": 15.0,
                }
                for i in range(leds)
            ],
            "unmapped": [],
            "stats": {"rmsReprojPxGlobal": 0.5, "medianParallaxDeg": 15.0},
        }
        await p.send({"type": "submit_map", "map": the_map}, "result_ready")
        await p.send(
            {
                "type": "submit_topology",
                "topology": {
                    "mapId": "probe-map",
                    "branchPoints": [],
                    "segments": [
                        {
                            "id": 0,
                            "a": -1,
                            "b": -1,
                            "polyline": [[0.0, 0.0, 0.0], [leds * 0.01, 0.0, 0.0]],
                            "length": leds * 0.01,
                        }
                    ],
                    "associations": [
                        {"ledId": i, "segmentId": 0, "footArclength": i * 0.01, "dPerp": 0.0}
                        for i in range(leds)
                    ],
                },
            },
            "result_ready",
            "topology",
        )

        # Playback: off is universal; anything else is a bounded refusal
        # until Phase G engines land.
        await p.send({"type": "get_playback"}, "playback_state")
        pb = await p.send({"type": "set_playback", "effect": "pulse"}, "error", "pulse")
        p.check(pb.get("code") == "unsupported_effect", f"pulse refusal code: {pb}")

        # Host-solve must be refused by a solverless player (the Pi would
        # happily run one); the phone-path stop succeeds on both profiles.
        if profile == "esp32":
            err = await p.send({"type": "stop_mapping"}, "error", "host solve")
            p.check(err.get("code") == "unsupported", f"host-solve refusal code: {err}")
        await p.send({"type": "stop_mapping", "solveOnHost": False}, "mapping_stopped")
        idle = await p.send({"type": "get_pattern"}, "pattern_state", "idle")
        p.check(idle["active"] is False, "pattern_state.active after stop")

        if p.failures:
            print(f"\n{len(p.failures)} FAILURE(S)")
            return 1
        print("\nall checks passed")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("url", help="player WS endpoint, e.g. ws://192.168.4.1:81/ws")
    ap.add_argument("--leds", type=int, default=64)
    ap.add_argument(
        "--run-seconds",
        type=float,
        default=8.0,
        help="how long to let the mapping pattern run for eyeballing the strip",
    )
    ap.add_argument(
        "--profile",
        choices=["esp32", "pi"],
        default="esp32",
        help="which player profile's contract to enforce",
    )
    ap.add_argument(
        "--insecure",
        action="store_true",
        help="skip TLS verification (self-signed wss:// players)",
    )
    args = ap.parse_args()
    return asyncio.run(run(args.url, args.leds, args.run_seconds, args.profile, args.insecure))


if __name__ == "__main__":
    sys.exit(main())
