#!/usr/bin/env python3
"""HITL E2E: Pi led_driver --output=fpga -> spi_ws281x FPGA -> WS2812 strips.

Reserves a `led-mapper-pi-fpga` DUT (a LED Mapper Pi wired to the spi_ws281x
FPGA), drives a known static frame over SPI, and uses the rig's FX2 logic
analyzer to validate BOTH ends of the chain:

  * the FPGA's WS2812 strip outputs decode (per port) to exactly the pixels the
    Pi sent, and
  * the raw SPI wire carries the expected `spi_ws281x` STREAM framing.

Because the FX2 has 8 channels, the default topology is small (2 ports): 3 SPI
lines (clk, mosi, cs) + one channel per WS output. Channel names and topology are
CLI-configurable to match how the rig is wired.

Run on a tailnet host via `//pi/hitl:hitl_shim` (see pi/hitl/BUILD.bazel), or as
the generated `//pi/hitl/harness:fpga_ws281x_led-mapper-pi-fpga` target.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from typing import List, Tuple

from hitl_client import Reservation
from led_driver import fpga_spi

RGB = Tuple[int, int, int]


def _get(server: str, path: str) -> dict:
    with urllib.request.urlopen(server.rstrip("/") + path, timeout=10) as r:
        return json.loads(r.read())


def require_analyzer(server: str) -> None:
    """Fail early unless the daemon at `server` advertises a logic analyzer."""
    a = _get(server, "/status").get("analyzer")
    if not (a and a.get("present")):
        raise SystemExit(f"[fpga] rig {server!r} has no logic analyzer — this test needs one")


def _reserved_device(server: str, res_id: str | None) -> str:
    """The DUT name this reservation holds (per-DUT channel maps have no default)."""
    for d in _get(server, "/status").get("devices", []):
        if d.get("reservation") == res_id or d.get("reservationId") == res_id:
            return d.get("name", "")
    raise SystemExit(f"[fpga] could not resolve reserved device for id={res_id}")


def _channel_map(server: str) -> dict:
    return _get(server, "/analyzer/channel-map")


def _set_channel_map(server: str, m: dict) -> None:
    req = urllib.request.Request(
        server.rstrip("/") + "/analyzer/channel-map",
        data=json.dumps(m).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def _capture(server: str, device: str, protocol: str, samples: int) -> dict:
    """POST /capture with an explicit protocol; return the raw result JSON."""
    body = json.dumps({"device": device, "protocol": protocol, "samples": samples}).encode()
    req = urllib.request.Request(
        server.rstrip("/") + "/capture", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def _capture_pixels(server: str, device: str, samples: int) -> List[RGB]:
    res = _capture(server, device, "ws2812", samples)
    return [(p["r"], p["g"], p["b"]) for p in (res.get("pixels") or [])]


def _capture_spi_bytes(server: str, device: str, samples: int) -> bytes:
    import base64

    res = _capture(server, device, "spi-raw", samples)
    return base64.b64decode(res.get("bytes") or "")


def _drive_static(res: Reservation, colors: List[RGB], fps: float = 10.0) -> None:
    """Hold a known static frame on the Pi's led_driver via its control socket.

    The Pi runs led-driver.service with ``--output=fpga --start N`` (see
    pi/provisioning), so the render loop is already live; ``set_debug static``
    overrides the frame it drives. We speak the control protocol (newline JSON
    over the unix socket) with STDLIB ONLY: this is a NETWORK DUT, whose system
    python3 has no ``led_driver`` on its path (it lives in the service's Nix
    env), so importing ControlClient there fails.
    """
    frame = [list(c) for c in colors]
    snippet = (
        "import socket, json, sys\n"
        "s = socket.socket(socket.AF_UNIX)\n"
        "s.connect('/run/ledmapper/control.sock')\n"
        f"msg = {{'cmd': 'set_debug', 'mode': 'static', 'args': {{'colors': {frame}}}}}\n"
        "s.sendall((json.dumps(msg) + '\\n').encode())\n"
        "buf = b''\n"
        "while b'\\n' not in buf:\n"
        "    buf += s.recv(4096)\n"
        "reply = json.loads(buf.split(b'\\n')[0])\n"
        "print(reply)\n"
        "sys.exit(0 if reply.get('ok') else 1)\n"
    )
    proc = res.ssh(["python3", "-c", snippet], capture=True, timeout=30)
    if proc.returncode != 0:
        raise SystemExit(
            f"[fpga] drive failed (rc={proc.returncode})\n{proc.stdout}\n{proc.stderr}"
        )


def _expected_frame(num_ports: int, leds_per_port: int) -> List[List[RGB]]:
    """A distinct known pattern: port p, led i -> a unique primary-ish colour."""
    palette = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255), (255, 0, 255)]
    out: List[List[RGB]] = []
    for p in range(num_ports):
        out.append([palette[(p * leds_per_port + i) % len(palette)] for i in range(leds_per_port)])
    return out


def run(args: argparse.Namespace) -> int:
    caps = [c for c in (args.require_caps or "").split(",") if c]
    # Ensure we land on an analyzer rig with the FPGA DUT mapped.
    for extra in ("logic-analyzer",):
        if extra not in caps:
            caps.append(extra)

    ws_channels = [c for c in args.ws_channels.split(",") if c]
    spi_channels = [c for c in args.spi_channels.split(",") if c]
    if len(ws_channels) < args.num_ports:
        raise SystemExit(f"need >= {args.num_ports} --ws-channels, got {ws_channels}")
    if len(spi_channels) < 2:
        raise SystemExit(f"--spi-channels needs clk,mosi[,cs], got {spi_channels}")

    port_frames = _expected_frame(args.num_ports, args.leds_per_port)
    flat: List[RGB] = [px for pf in port_frames for px in pf]

    # Auto-size the capture to span one full frame + reset at 24 MHz (leds*24 bits
    # * 1.25us/bit), with margin, unless overridden.
    samples = args.samples or int(args.leds_per_port * 24 * 1.25e-6 * 24e6 * 1.6) + 100_000

    res = Reservation(
        server=args.server or None,
        owner=args.owner,
        require_caps=caps,
        device=args.device or None,
        sku=args.sku or None,
    )
    res.acquire()
    try:
        require_analyzer(res.server)
        device = args.device or _reserved_device(res.server, res.id)

        _drive_static(res, flat, fps=args.fps)
        time.sleep(0.5)  # let the CSR + a few STREAM frames reach the wire

        saved = _channel_map(res.server)
        errors: List[str] = []
        try:
            # 1) Each WS output decodes to that port's pixels.
            for p in range(args.num_ports):
                _set_channel_map(
                    res.server, {device: {"channels": [ws_channels[p]], "protocol": "ws2812"}}
                )
                got = _capture_pixels(res.server, device, samples)
                want = port_frames[p]
                if got[: len(want)] != want:
                    errors.append(f"port {p} ws2812: got {got[:len(want)]} want {want}")

            # 2) The raw SPI wire carries the expected STREAM framing.
            _set_channel_map(
                res.server, {device: {"channels": spi_channels, "protocol": "spi-raw"}}
            )
            wire = _capture_spi_bytes(res.server, device, samples)
            payload = fpga_spi.encode_stream(port_frames)  # 0x02 + round-robin GRB
            if bytes(payload) not in bytes(wire):
                errors.append(
                    f"spi wire missing STREAM payload ({len(payload)}B) in capture ({len(wire)}B)"
                )
        finally:
            _set_channel_map(res.server, saved)

        if errors:
            print("[fpga] FAIL:\n  " + "\n  ".join(errors), file=sys.stderr)
            return 1
        print(f"[fpga] PASS: {args.num_ports} ports x {args.leds_per_port} leds validated")
        return 0
    finally:
        res.release()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default="")
    ap.add_argument("--owner", default="hitl-fpga-ws281x")
    ap.add_argument("--device", default="")
    ap.add_argument("--sku", default="")
    ap.add_argument("--require-caps", default="")
    ap.add_argument("--num-ports", type=int, default=2)
    ap.add_argument("--leds-per-port", type=int, default=2)
    ap.add_argument("--fps", type=float, default=10.0, help="refresh rate to drive + validate")
    # One WS frame = leds*24 bits * 1.25us; size samples to span it + reset. At
    # 24 MHz, 550 LEDs (~16.5ms) needs ~400k; default scales with leds below.
    ap.add_argument("--samples", type=int, default=0, help="0 = auto from leds-per-port")
    ap.add_argument("--ws-channels", default="D3,D4", help="one channel per WS output")
    ap.add_argument("--spi-channels", default="D0,D1,D2", help="clk,mosi,cs")
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
