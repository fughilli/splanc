"""On-hardware large-map upload test (FUG-74).

Reserve a rig, flash + ImprovBLE-provision a real ESP32-C6, then over the player
WebSocket prove that uploading a big map+topology actually works end to end:

  1. Shard a large submit_map (256 LEDs ≈ 15 KB, the firmware's cap) into
     UploadChunk windows and stream them — a chunk_ack for every non-final window
     and a result_ready for the last. Before FUG-74 this dropped the socket
     ("Send failed: socket closed"): the whole frame was one ~15 KB TLS record
     the C6 couldn't allocate on its fragmented heap.
  2. Do the same for a multi-KB submit_topology.
  3. Read it all back with get_stored_map and decode the MappingBundle — assert
     the led_count, a sample LED, and the segment/association counts survive the
     round trip (upload -> streamed decode -> arena -> dump). This catches a
     silently-truncated or mis-reassembled upload, not just a dropped socket.

Runs over wss:443 by default — the transport where the OOM actually bit (a big
contiguous TLS record); --ws-scheme ws hits the plaintext :81 path, which shards
the same way. Reaches the DUT like //pi/hitl/harness:e2e / :mapping_trigger — the
board lives on the rig's WiFi LAN, tunneled through the reservation.

    bazel run //pi/hitl/harness:map_upload -- \
        [--server http://<rig>:8087] [--wifi-ssid SSID --wifi-pass PSK]
    # or, against an already-reachable board (skip reserve/flash/provision):
    bazel run //pi/hitl/harness:map_upload -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import sys
import time
from typing import Any

from map_upload_core import synth_output_map, synth_topology, window_plan


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")
    except Exception:
        return None


# -- WebSocket plumbing (mirrors hitl_mapping / fx_bench) ---------------------


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


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    import websockets

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
            await _rpc(
                sock, {"type": "hello", "client": "hitl_map_upload", "app_version": "1"}, "welcome"
            )
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


# -- the sharded upload (mirrors web/src/net/client.ts sendChunked) -----------


async def _submit_chunked(sock, flat: dict[str, Any], kind: str, upload_id: int, label: str) -> str:
    """Encode `flat` (submit_map / submit_topology), slice it into UploadChunk
    windows, and stream them — awaiting a chunk_ack per non-final window and a
    result_ready for the last. Returns the reply's map_id. Frames that already
    fit one window take the ordinary single-frame path."""
    from server import proto_wire

    frame = proto_wire.encode_client(flat)
    windows = window_plan(len(frame))
    _log(f"[{label}] {len(frame)} B -> {len(windows)} window(s), upload_id={upload_id}")
    if len(windows) <= 1:
        reply = await _rpc(sock, flat, "result_ready")
        return reply.get("mapId", "")

    for seq, off, end, last in windows:
        chunk = {
            "type": "upload_chunk",
            "upload_id": upload_id,
            "seq": seq,
            "last": last,
            "kind": kind,
            "payload": base64.b64encode(frame[off:end]).decode("ascii"),
        }
        if last:
            reply = await _rpc(sock, chunk, "result_ready")
            _log(
                f"[{label}]   window {seq} (last, {end - off} B) -> result_ready {reply.get('mapId')}"
            )
            return reply.get("mapId", "")
        ack = await _rpc(sock, chunk, "chunk_ack")
        if ack.get("uploadId") != upload_id or ack.get("seq") != seq:
            raise RuntimeError(f"[{label}] chunk_ack mismatch: got {ack}, want {upload_id}/{seq}")
        _log(f"[{label}]   window {seq} ({end - off} B) -> chunk_ack")
    raise RuntimeError(f"[{label}] no final window")  # unreachable: last always returns


async def _pull_bundle(sock, chunk_len: int = 1024) -> tuple[bytes, bool]:
    """Read the stored map+topology back off the device via get_stored_map,
    reassembling the MappingBundle byte window by window (mirrors the app's
    pullStoredMap). Returns (bundle_bytes, has_topology)."""
    assembled = b""
    has_topology = False
    while True:
        reply = await _rpc(
            sock,
            {"type": "get_stored_map", "offset": len(assembled), "max_len": chunk_len},
            "stored_map_chunk",
        )
        total = int(reply.get("totalLen", 0))
        has_topology = bool(reply.get("hasTopology", False))
        data = base64.b64decode(reply.get("data", "") or "")
        if not data:
            break
        assembled += data
        if len(assembled) >= total:
            break
    return assembled, has_topology


async def _run(ws_url: str, n_leds: int, insecure: bool) -> bool:
    """Drive the large-map upload + read-back check; True on PASS. Raises on
    setup failures (test errors, distinct from the assertion failing)."""
    map_id = "__fug74"
    map_flat = synth_output_map(n_leds, map_id)
    topo_flat = synth_topology(n_leds, map_id)

    # A freshly-provisioned board is still bringing up wss:443: after a cold
    # --erase-fs flash it reformats littlefs, joins WiFi, re-issues the LAN cert
    # and restarts the TLS server, which occasionally exceeds 25s (that race is
    # what reddened CI). 60s is pure slack — a warm DUT answers on the first try.
    sock = await _open_ws(ws_url, insecure, time.monotonic() + 60.0)
    try:
        # (1) + (2): the uploads themselves. A dropped socket / OOM raises here.
        got_map_id = await _submit_chunked(sock, map_flat, "MAP", 1, "map")
        if got_map_id != map_id:
            _log(f"FAIL: submit_map result_ready map_id={got_map_id!r}, expected {map_id!r}")
            return False
        got_topo_id = await _submit_chunked(sock, topo_flat, "TOPOLOGY", 2, "topology")
        if got_topo_id != map_id:
            _log(f"FAIL: submit_topology result_ready map_id={got_topo_id!r}, expected {map_id!r}")
            return False

        # (3): read it back and prove the bytes survived the round trip.
        from ledmapper_pb2 import MappingBundle

        assembled, has_topology = await _pull_bundle(sock)
        _log(f"[readback] {len(assembled)} B bundle, has_topology={has_topology}")
        if not has_topology:
            _log("FAIL: get_stored_map reports no topology after a topology upload")
            return False
        bundle = MappingBundle()
        bundle.ParseFromString(assembled)
        ok = (
            bundle.map.led_count == n_leds
            and len(bundle.map.leds) == n_leds
            and bundle.map.leds[n_leds - 1].id == n_leds - 1
            and len(bundle.topology.segments) == len(topo_flat["topology"]["segments"])
            and len(bundle.topology.associations) == n_leds
        )
        _log(
            f"[readback] led_count={bundle.map.led_count} leds={len(bundle.map.leds)} "
            f"segments={len(bundle.topology.segments)} associations={len(bundle.topology.associations)}"
        )
        _log(
            "PASS: large map + topology uploaded (sharded), decoded, and round-tripped"
            if ok
            else "FAIL: stored map/topology does not match what was uploaded"
        )
        return ok
    finally:
        try:
            await sock.close()
        except OSError:
            pass


def run_on_hardware(args) -> bool:
    # An explicit --device-ws reachable from here skips the rig entirely.
    if args.device_ws:
        return asyncio.run(_run(args.device_ws, args.led_count, args.insecure))

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[improv] provisioning onto the rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} -> {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 120,
            )

        if not ssid:
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid or --device-ws")
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, args.ws_scheme)
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            return asyncio.run(_run(ws_url, args.led_count, args.insecure))
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL large-map upload test (FUG-74)")
    ap.add_argument(
        "--device-ws",
        help="connect straight to a reachable player WebSocket (skip reserve/flash/provision), "
        "e.g. wss://<ip>/ws",
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: the one in runfiles); "
        "pass --no-bundle to test whatever is already flashed",
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument(
        "--led-count",
        type=int,
        default=256,
        help="LEDs in the synthetic map (256 = firmware cap ≈ 15 KB, the FUG-74 OOM size)",
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--ws-scheme", choices=["ws", "wss"], default="wss")
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    ap.add_argument("--monitor-seconds", type=float, default=25.0)
    args = ap.parse_args()
    args.insecure = not args.ws_verify

    ok = run_on_hardware(args)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
