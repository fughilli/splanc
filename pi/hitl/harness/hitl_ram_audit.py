"""Capture an ESP32-C6 core image at the device's minimum heap watermark.

Drives the worst-case heap scenario on a reserved HITL board while a JTAG
watcher (ram_watch.tcl) polls every heap's free bytes over the system bus — no
halting — and, at each new low, halts just long enough to dump HP SRAM, LP
SRAM and the CPU registers. The last dump is the RAM image at (or within
--step bytes of) the run's lowest free heap, for offline attribution against
the firmware ELF (heap walk via the light-poisoning canaries, FreeRTOS task
lists for stacks + 0xA5 high-water).

Scenario (loaded_tls's, the field worst case): flash → BLE-provision → first
wss handshake while BLE is still up → load a full 512-LED map + a
texture-sampling effect + a streamed texture keyframe → --rounds fresh wss
handshakes + cert-page GETs on the loaded heap.

    bazel run //pi/hitl/harness:ram_audit -- --server http://hitl-rig-2:8087 \\
        --device c6-003f08 --out /tmp/ram_audit
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import struct
import threading
import time

import heap_census
import hitl_ws
from hitl_client import Reservation
from hitl_loaded_tls import _drive, compile_fx_src, default_flashbundle, default_fx_compile
from loaded_tls_core import bars_effect_src
from provision import dut_target, provision_dut


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rloc)
    except Exception:
        return None


def elf_symbol(path: str, name: str) -> int | None:
    """Address of a symbol in a little-endian ELF32 (the firmware image): the heap
    list the watcher polls moves with every build, so it's read from the very ELF
    the flashed bundle was linked from."""
    with open(path, "rb") as fh:
        d = fh.read()
    (shoff,) = struct.unpack_from("<I", d, 0x20)
    shentsize, shnum = struct.unpack_from("<HH", d, 0x2E)
    secs = [struct.unpack_from("<IIIIIIIIII", d, shoff + i * shentsize) for i in range(shnum)]
    want = name.encode()
    for sec in secs:
        if sec[1] != 2:  # SHT_SYMTAB
            continue
        strtab = secs[sec[6]]
        for off in range(sec[4], sec[4] + sec[5], 16):
            st_name, st_value = struct.unpack_from("<II", d, off)
            s0 = strtab[4] + st_name
            if d[s0 : d.index(b"\0", s0)] == want:
                return st_value
    return None


MODE_FIELDS = (
    "polls accepted refused refused_not_applicable refused_no_transport refused_not_joined "
    "refused_no_effect unmodeled state last_refusal"
).split()


def _report_mode(log_path: str) -> None:
    """Print the firmware's memory-mode tracker counters (LM_MODE) the watcher read."""
    try:
        lines = [ln for ln in open(log_path) if " LM_MODE " in ln]
    except OSError:
        _log("[mode] no watcher log (JTAG didn't attach); see the status line's mode= in dut0.log")
        return
    if not lines:
        _log("[mode] no LM_MODE read (image without the tracker, or the watcher didn't attach)")
        return
    vals = [int(v, 0) for v in lines[-1].split("LM_MODE", 1)[1].split()]
    _log(
        "[mode] "
        + " ".join(
            f"{k}={v:#x}" if k in ("state", "last_refusal") else f"{k}={v}"
            for k, v in zip(MODE_FIELDS, vals)
        )
    )


def _fetch(res: Reservation, remote: str, local: str) -> bool:
    """Copy a container file back (base64 over ssh: the image has no scp-from)."""
    p = res.ssh(f"base64 -w0 {remote} 2>/dev/null", capture=True, timeout=300)
    if p.returncode != 0 or not p.stdout:
        return False
    with open(local, "wb") as fh:
        fh.write(base64.b64decode(p.stdout.strip()))
    return True


def _watcher(res: Reservation, args, out: dict) -> threading.Thread:
    """Run ram_watch.tcl in the container until /tmp/ram_watch.stop appears,
    retrying the attach: the C6's debug module sometimes reports a stuck abstract
    command on the first examine of a running core."""
    script = os.path.basename(args.watch_tcl)
    if args.hang:
        sets = f'-c "set ticks {args.ticks:#x}" '
    else:
        sets = (
            f'-c "set thresh {args.thresh}" -c "set step {args.step}" '
            f'-c "set heads {args.heads:#x}" -c "set mode {args.mode:#x}" '
        )
        if args.census:
            sets += (
                f'-c "set census_addr {args.census[0]:#x}" -c "set census_size {args.census[1]}" '
            )
    cmd = (
        "rm -rf /tmp/ram_watch /tmp/ram_watch.stop /tmp/ram_watch.arm; mkdir -p /tmp/ram_watch; "
        "for i in 1 2 3 4 5 6; do "
        f"hitl-jtag {sets}"
        f"-f /tmp/{script} > /tmp/ram_watch/openocd.log 2>&1 && break; "
        "[ -e /tmp/ram_watch.stop ] && break; echo attach-retry $i >> /tmp/ram_watch/retries; "
        "sleep 3; done"
    )

    def run():
        out["proc"] = res.ssh(cmd, capture=True, timeout=args.max_seconds)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "ram_audit"))
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--watch-tcl", default=_runfile("_main/pi/hitl/harness/ram_watch.tcl"))
    ap.add_argument(
        "--hang",
        action="store_true",
        help="catch a hard hang instead (hang_watch.tcl): halt + dump when the tick stops",
    )
    ap.add_argument(
        "--elf",
        default=_runfile("_main/firmware/player_app/esp32c6_netstack.elf"),
        help="ELF the bundle was built from (for the heap list address)",
    )
    ap.add_argument("--out", default="ram_audit_out")
    ap.add_argument("--thresh", type=int, default=9000, help="dump only below this total free")
    ap.add_argument("--step", type=int, default=512, help="re-dump only this far below the last")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--led-count", type=int, default=512)
    ap.add_argument("--tex-width", type=int, default=40)
    ap.add_argument("--tex-height", type=int, default=40)
    ap.add_argument("--max-seconds", type=float, default=1800)
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    args = ap.parse_args()
    if args.hang:
        args.watch_tcl = _runfile("_main/pi/hitl/harness/hang_watch.tcl")
        args.ticks = elf_symbol(args.elf, "xTickCount") if args.elf else None
    args.heads = elf_symbol(args.elf, "registered_heaps") if args.elf else None
    if args.heads is None:
        ap.error(f"registered_heaps not found in --elf {args.elf}")
    _log(f"[elf] registered_heaps @ {args.heads:#x}")
    # A heap-census build (--//firmware/player_app:heap_census): the watcher dumps the
    # table at the end of the run and it is symbolized against the same ELF.
    args.census = heap_census.symbol(heap_census.elf_symbols(args.elf), "LM_HEAP_CENSUS")
    if args.census:
        _log(f"[elf] LM_HEAP_CENSUS @ {args.census[0]:#x} ({args.census[1]} B)")
    # The memory-mode tracker's counters (0 = an image without the tracker).
    args.mode = elf_symbol(args.elf, "LM_MODE") or 0
    # Fields hitl_loaded_tls._drive reads.
    args.effect_id, args.tex_index = "__ramaudit", 0
    args.settle, args.open_timeout, args.recover_window = (
        hitl_ws.CONNECT_SETTLE,
        hitl_ws.OPEN_TIMEOUT,
        40.0,
    )
    os.makedirs(args.out, exist_ok=True)

    fxb = compile_fx_src(default_fx_compile(), bars_effect_src(args.tex_width, args.tex_height))
    res = Reservation(server=args.server, owner=args.owner, device=args.device)
    res.acquire()
    watcher = None
    try:
        ssid, password = res.wifi() or ("", "")
        res.scp_to([args.bundle, args.watch_tcl], "/tmp/")
        _log(f"[flash] {os.path.basename(args.bundle)}")
        res.ssh(
            f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
            capture=True,
            timeout=200,
        )
        wout: dict = {}
        watcher = _watcher(res, args, wout)
        time.sleep(8)  # attach before the BLE + first-handshake peak
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        # Arm the dumps only now: a ~46 s halt inside the WiFi join ends in a watchdog
        # reset. The minimum (first wss handshake) comes after this point.
        res.ssh("touch /tmp/ram_watch.arm", capture=True, timeout=30)
        host, port = dut_target(redirect, "wss")
        _log(f"[dut] {host}:{port}")
        with res.forward(host, port) as local_port:
            result = asyncio.run(_drive(f"wss://localhost:{local_port}/ws", True, args, fxb))
        _log(f"[scenario] {result['result_line']}")
        return 0
    finally:
        # Collect the watcher's output even when the scenario failed — with
        # --hang, a failure is exactly when the dump exists.
        try:
            time.sleep(3)
            res.ssh("touch /tmp/ram_watch.stop", capture=True, timeout=30)
            if watcher is not None:
                watcher.join(timeout=120)
            names = (
                "log.txt",
                "openocd.log",
                "retries",
                "hp.bin",
                "lp.bin",
                "regs.txt",
                "pcs.txt",
                "census.bin",
            )
            for name in names:
                ok = _fetch(res, f"/tmp/ram_watch/{name}", os.path.join(args.out, name))
                _log(f"[fetch] {name}: {'ok' if ok else 'missing'}")
            census_bin = os.path.join(args.out, "census.bin")
            if args.census and os.path.exists(census_bin):
                with open(census_bin, "rb") as fh:
                    census = heap_census.parse(fh.read())
                sym = heap_census.Symbolizer(heap_census.elf_symbols(args.elf))
                with open(os.path.join(args.out, "census.md"), "w") as fh:
                    fh.write(heap_census.render(census, sym))
                _log(f"[census] {os.path.join(args.out, 'census.md')}")
            _report_mode(os.path.join(args.out, "log.txt"))
        finally:
            res.release()


if __name__ == "__main__":
    raise SystemExit(main())
