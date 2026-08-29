#!/usr/bin/env python3
"""HITL E2E: Pi player_rs (Rust) -> spi_ws281x FPGA -> WS2812 strips.

Reserves a `led-mapper-pi` DUT with the `spi-fpga` + `led-strip` capabilities (a
LED Mapper Pi wired to the spi_ws281x FPGA — the FPGA is a per-DUT capability, not
a distinct SKU), drives a known static frame over the player's WebSocket — exactly
as the phone would — and uses the rig's FX2 logic analyzer to validate BOTH ends of
the chain:

  * the FPGA's WS2812 strip outputs decode (per port) to exactly the pixels the
    Pi sent, and
  * the raw SPI wire carries the expected `spi_ws281x` STREAM framing.

The Pi is a *network DUT* (`runner.Device.Kind == "network"`): the reservation is a
container on the rig with no board, and it reaches the Pi only over the LAN (via
`$HITL_DUT_ADDR`) — never the Pi's local control socket. So — like
//pi/hitl/harness:map_upload against the ESP32 — we `res.forward` a local port to
the Pi's WSS (:8443, `$HITL_DUT_ADDR` inside the container) and speak the protocol
over it: a `set_counting_pattern` of one solid ColorBlock per FPGA port. The Rust
player's render loop (render.rs `Source::Counting`) then drives those colours out
the FPGA, applying the message's `color_order` — so we send "GRB" and the wire
bytes land in WS2812 order for the sigrok `ws2812` decoder.

Because the FX2 has 8 channels, the default topology taps all 4 FPGA ports + 3 SPI
lines (clk, mosi, cs) = 7. Channel names and topology are CLI-configurable to match
how the rig is wired; `--num-ports` MUST match the deployed player's `--fpga-ports`
(the codec splits the counting LEDs evenly across that many ports).

Run on a tailnet host via `//pi/hitl:hitl_shim` (see pi/hitl/BUILD.bazel), or as
the generated `//pi/hitl/harness:fpga_ws281x_led-mapper-pi` target.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import sys
import time
import urllib.request
from typing import Any, List, Tuple

from hitl_client import Reservation
from led_driver import fpga_spi

RGB = Tuple[int, int, int]

# One distinct solid colour per FPGA port — each driven as a single contiguous
# ColorBlock so, after the codec's even split across ports, port p is a solid
# `_PALETTE[p]`. Primary-ish so the ws2812 decode is unambiguous.
_PALETTE: List[RGB] = [
    (255, 0, 0),
    (0, 255, 0),
    (0, 0, 255),
    (255, 255, 0),
    (0, 255, 255),
    (255, 0, 255),
]


def _get(server: str, path: str) -> dict:
    with urllib.request.urlopen(server.rstrip("/") + path, timeout=10) as r:
        return json.loads(r.read())


def require_analyzer(server: str) -> None:
    """Fail early unless the daemon at `server` advertises a logic analyzer."""
    a = _get(server, "/status").get("analyzer")
    if not (a and a.get("present")):
        raise SystemExit(f"[fpga] rig {server!r} has no logic analyzer — this test needs one")


def _reserved_device(server: str, res_id: str | None) -> str:
    """The DUT name this reservation holds (per-DUT channel maps have no default).

    Each /status device carries its current holder under `active` (api.Reservation),
    so match on `active.id` (matches this reservation) — network DUTs included."""
    for d in _get(server, "/status").get("devices", []):
        active = d.get("active") or {}
        if active.get("id") == res_id:
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


def _expected_frame(num_ports: int, leds_per_port: int) -> List[List[RGB]]:
    """The per-port frames we expect on the WS wire: port p is a solid `_PALETTE[p]`."""
    return [[_PALETTE[p % len(_PALETTE)]] * leds_per_port for p in range(num_ports)]


def _counting_blocks(num_ports: int, leds_per_port: int) -> List[dict]:
    """One ColorBlock per port: a contiguous run of that port's solid colour.

    The counting LEDs are `num_ports*leds_per_port` total; the player codec splits
    them evenly across `num_ports` ports (wire.rs `split_ports`, port_counts=None),
    so block p — covering `[p*lpp, (p+1)*lpp)` — lands entirely on port p. rgb is
    normalized to [0,1] per the proto (ColorBlock.rgb)."""
    blocks: List[dict] = []
    for p in range(num_ports):
        r, g, b = _PALETTE[p % len(_PALETTE)]
        blocks.append(
            {
                "start": p * leds_per_port,
                "count": leds_per_port,
                "rgb": [r / 255.0, g / 255.0, b / 255.0],
            }
        )
    return blocks


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 15.0) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise RuntimeError(f"device error to {flat.get('type')}: {msg}")
        # ignore unsolicited frames until the awaited reply arrives.


async def _open_ws(ws_url: str, settle_deadline: float):
    """Open the player WSS + hello->welcome, retrying until `settle_deadline`.

    Mirrors //pi/hitl/harness:map_upload `_open_ws`: the tunnel may beat the
    player's TLS listener (fresh boot / just-restarted service), so a first
    connect can time out — retry rather than fail the whole run on the race.
    """
    import websockets

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE  # self-signed player cert
    while True:
        try:
            sock = await websockets.connect(ws_url, ssl=ssl_ctx, open_timeout=8)
            await _rpc(
                sock, {"type": "hello", "client": "hitl_fpga_ws281x", "app_version": "1"}, "welcome"
            )
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(
                    f"[fpga] player WSS never came up at {ws_url}: {type(e).__name__}: {e}"
                )
            print(f"[fpga] ws not up yet ({type(e).__name__}); retrying…", flush=True)
            await asyncio.sleep(1.5)


async def _drive_counting(ws_url: str, num_ports: int, leds_per_port: int) -> None:
    """Connect to the player's WSS and hold a known counting pattern.

    hello->welcome, then `set_counting_pattern` with one solid ColorBlock per port
    and `color_order="GRB"` so the render's counting path (render.rs, which honours
    `counting_color_order`) emits WS2812-order bytes on the wire.
    """
    sock = await _open_ws(ws_url, time.monotonic() + 30.0)
    try:
        await _rpc(
            sock,
            {
                "type": "set_counting_pattern",
                "blocks": _counting_blocks(num_ports, leds_per_port),
                "channel": 0,
                "color_order": "GRB",
            },
            "counting_state",
        )
    finally:
        try:
            await sock.close()
        except OSError:
            pass


def _dut_addr(res: Reservation) -> str:
    """The network DUT's LAN address, from `$HITL_DUT_ADDR` in the reservation
    container (seeded via //pi/hitl:seed_network_dut) — the far end for res.forward.
    The Pi's WSS isn't the container's, so we tunnel to it explicitly."""
    proc = res.ssh('printf %s "$HITL_DUT_ADDR"', capture=True, timeout=20)
    addr = (proc.stdout or "").strip()
    if proc.returncode != 0 or not addr:
        raise SystemExit(
            f"[fpga] could not resolve $HITL_DUT_ADDR for the network DUT "
            f"(rc={proc.returncode}): {proc.stdout!r} {proc.stderr!r}"
        )
    return addr


def run(args: argparse.Namespace) -> int:
    caps = [c for c in (args.require_caps or "").split(",") if c]
    # Ensure we land on an analyzer rig whose FX2 taps the FPGA's WS2812 strip
    # outputs (the primary, always-on validation). The raw-SPI STREAM cross-check
    # (--check-spi-stream) additionally wants a logic-analyzer-spi tap; it's gated
    # off by default (FX2 sample-rate fidelity), so we don't require it here.
    for extra in ("logic-analyzer-led-strip",):
        if extra not in caps:
            caps.append(extra)

    ws_channels = [c for c in args.ws_channels.split(",") if c]
    spi_channels = [c for c in args.spi_channels.split(",") if c]
    if len(ws_channels) < args.num_ports:
        raise SystemExit(f"need >= {args.num_ports} --ws-channels, got {ws_channels}")
    if len(spi_channels) < 2:
        raise SystemExit(f"--spi-channels needs clk,mosi[,cs], got {spi_channels}")

    port_frames = _expected_frame(args.num_ports, args.leds_per_port)

    # Auto-size the capture to span one full frame + reset at 24 MHz (leds*24 bits
    # * 1.25us/bit), with margin, unless overridden. The FX2 arms on the data
    # line's first rising edge, so a single frame's worth (+ margin) suffices.
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

        # Drive the DUT over WS (like the phone): tunnel to its WSS via the rig,
        # then set a known counting pattern. The render loop (already live from
        # led-driver.service) picks it up and streams it out the FPGA.
        addr = _dut_addr(res)
        with res.forward(addr, args.serve_port) as local_port:
            asyncio.run(
                _drive_counting(
                    f"wss://localhost:{local_port}/ws", args.num_ports, args.leds_per_port
                )
            )
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

            # 2) The raw SPI wire carries the expected STREAM framing. OFF BY
            # DEFAULT (--check-spi-stream to enable): the FX2/fx2lafw analyzer
            # samples at 24 MHz but the player drives SPI at 6.4 MHz — only ~3.75
            # samples/bit, too marginal for a clean sigrok SPI decode, so the
            # captured bytes never contain the full STREAM payload even when the
            # wire is correct. This check is redundant with (1) anyway: a correct
            # ws2812 output proves the FPGA received the right SPI STREAM. Re-enable
            # once it's sample-rate-aware (lower the test SPI clock, or a faster LA).
            # See pi/hitl/WORKLOG.md 2026-08-28.
            if args.check_spi_stream:
                _set_channel_map(
                    res.server, {device: {"channels": spi_channels, "protocol": "spi-raw"}}
                )
                wire = _capture_spi_bytes(res.server, device, samples)
                payload = fpga_spi.encode_stream(port_frames)  # 0x02 + round-robin GRB
                if bytes(payload) not in bytes(wire):
                    errors.append(
                        f"spi wire missing STREAM payload ({len(payload)}B) in capture ({len(wire)}B)"
                    )
            else:
                print("[fpga] raw-SPI STREAM cross-check skipped (--check-spi-stream to enable)")
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
    # MUST match the deployed player's --fpga-ports (pi/provisioning: 4): the codec
    # splits the counting LEDs evenly across that many ports.
    ap.add_argument("--num-ports", type=int, default=4)
    ap.add_argument("--leds-per-port", type=int, default=8)
    ap.add_argument("--serve-port", type=int, default=8443, help="player WSS port on the DUT")
    # One WS frame = leds*24 bits * 1.25us; size samples to span it + reset. At
    # 24 MHz, 550 LEDs (~16.5ms) needs ~400k; default scales with leds below.
    ap.add_argument("--samples", type=int, default=0, help="0 = auto from leds-per-port")
    # rig-1 wiring (pins 70..73 -> D0,D2,D4,D6; SPI clk=D3,mosi=D1,cs=D5).
    ap.add_argument("--ws-channels", default="D0,D2,D4,D6", help="one channel per WS output")
    ap.add_argument("--spi-channels", default="D3,D1,D5", help="clk,mosi,cs")
    # OFF by default: the FX2 LA can't cleanly decode the 6.4 MHz SPI (3.75
    # samples/bit), and the check is redundant with the ws2812 capture. See run().
    ap.add_argument(
        "--check-spi-stream", action="store_true", help="also verify the raw SPI STREAM"
    )
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
