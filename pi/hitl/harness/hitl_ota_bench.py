"""OTA transfer bench: how fast an image streams into a reachable player.

The app's OTA (web/src/net/otaUpdate.ts) is stop-and-wait: one ota_chunk, wait for its
ota_status, the next. This streams the image of a real `.ota` package into a player that
updates in-app (the P4, or a C6 app), times every chunk's round trip, and by default
ABORTS before ota_finish, so nothing is installed and an experiment takes seconds:

    bazel run //pi/hitl/harness:ota_bench -- --device-ws wss://192.168.100.168/ws \\
        --package esp32p4_player_c6_ota_test.ota --chunk-bytes 3800 --chunks 120

`--window N` keeps N chunks in flight (the device must keep them in order and answer
each); `--install` finishes and installs instead of aborting. Prints one JSON line:
throughput, per-chunk RTT percentiles, and what the device reported.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import ssl
import sys
import time

import ota_core as oc


async def run(args) -> dict:
    import websockets

    pkg = open(args.package, "rb").read()
    manifest, image, m = oc.split_package(pkg)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = await websockets.connect(args.device_ws, ssl=ctx, max_size=2**22)

    async def recv_arm(want: str, timeout: float = 30.0):
        end = time.monotonic() + timeout
        while True:
            arm, msg = oc.server(await asyncio.wait_for(sock.recv(), max(0.01, end - time.monotonic())))
            if arm == want:
                return msg
            if arm == "error":
                raise oc.OtaError(msg.code or "error", msg.message)

    await sock.send(oc.client(hello=oc.pb.Hello(client="ota_bench", app_version="1")))
    w = await recv_arm("welcome")
    out: dict = {"device": args.device_ws, "fw": w.fw_version, "image": m.size}
    if args.ping:
        # The path's fixed cost: sequential get_ota_status (no flash work on the device).
        ps = []
        for _ in range(args.ping):
            t = time.monotonic()
            await sock.send(oc.client(get_ota_status=oc.pb.GetOtaStatus()))
            await recv_arm("ota_status")
            ps.append((time.monotonic() - t) * 1e3)
        ps.sort()
        out["ping_p50_ms"] = round(ps[len(ps) // 2], 1)
        out["ping_p95_ms"] = round(ps[min(len(ps) - 1, int(0.95 * len(ps)))], 1)
        await sock.close()
        return out
    await sock.send(oc.client(ota_begin=oc.pb.OtaBegin(manifest=manifest, allow_downgrade=True)))
    st = await recv_arm("ota_status")
    if st.state == oc.FAILED:
        out["refused"] = st.error
        await sock.close()
        return out
    out["state"] = oc.pb.OtaStatus.State.Name(st.state)
    out["max_chunk"] = st.max_chunk
    if st.state == oc.REBOOTING:
        out["note"] = "the device hands off to its loader (a C6): bench it there with --device-ws again"
        await sock.close()
        return out
    chunk = min(args.chunk_bytes or st.max_chunk or 4096, st.max_chunk or 4096)
    out["chunk"] = chunk
    offset = start = st.offset
    out["resumed_at"] = start
    end_at = m.size if args.chunks <= 0 else min(m.size, offset + args.chunks * chunk)
    sent_at: dict[int, float] = {}
    rtts: list[float] = []
    nxt = offset
    t0 = time.monotonic()
    while offset < end_at:
        while nxt < end_at and len(sent_at) < args.window:
            e = min(nxt + chunk, end_at if args.chunks > 0 else m.size)
            sent_at[nxt] = time.monotonic()
            await sock.send(oc.client(ota_chunk=oc.pb.OtaChunk(offset=nxt, data=image[nxt:e])))
            nxt = e
        st = await recv_arm("ota_status")
        now = time.monotonic()
        if st.state == oc.FAILED and st.error != "out_of_order":
            out["error"] = st.error
            break
        # The oldest in flight is answered (in order).
        first = min(sent_at)
        rtts.append((now - sent_at.pop(first)) * 1e3)
        offset = max(offset, st.offset)
    dt = time.monotonic() - t0
    rtts.sort()
    pick = lambda p: round(rtts[min(len(rtts) - 1, int(p / 100 * len(rtts)))], 1) if rtts else None  # noqa: E731
    out.update(
        bytes=offset - start,
        seconds=round(dt, 2),
        kib_s=round((offset - start) / 1024 / dt, 1) if dt > 0 else None,
        full_image_s=round(m.size / ((offset - start) / dt), 1) if dt > 0 and offset > start else None,
        rtt_p50_ms=pick(50),
        rtt_p95_ms=pick(95),
        rtt_max_ms=round(rtts[-1], 1) if rtts else None,
        window=args.window,
    )
    if args.install and offset >= m.size:
        await sock.send(oc.client(ota_finish=oc.pb.OtaFinish()))
        st = await recv_arm("ota_status", timeout=60)
        out["finish"] = oc.pb.OtaStatus.State.Name(st.state)
    else:
        await sock.send(oc.client(ota_abort=oc.pb.OtaAbort()))
        try:
            st = await recv_arm("ota_status", timeout=10)
            out["aborted"] = oc.pb.OtaStatus.State.Name(st.state)
        except Exception as e:  # noqa: BLE001
            out["aborted"] = f"no reply ({type(e).__name__})"
    await sock.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--device-ws", required=True)
    ap.add_argument("--package", required=True, help="a signed .ota the device accepts")
    ap.add_argument("--chunk-bytes", type=int, default=0, help="0: the device's max_chunk")
    ap.add_argument("--chunks", type=int, default=150, help="chunks to send (0: the whole image)")
    ap.add_argument("--window", type=int, default=1, help="chunks in flight")
    ap.add_argument("--ping", type=int, default=0, help="only time N get_ota_status round trips")
    ap.add_argument("--install", action="store_true", help="finish and install (needs --chunks 0)")
    r = asyncio.run(run(ap.parse_args()))
    print(json.dumps(r), flush=True)
    return 0 if "error" not in r and "refused" not in r else 1


if __name__ == "__main__":
    sys.exit(main())
