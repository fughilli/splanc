#!/usr/bin/env python3
"""la_probe — read the Pi's spi_ws281x SPI wire with a local logic analyzer.

A standalone, host-side companion to the rig's HITL analyzer: you run it on the
machine the LA is physically attached to (e.g. your Mac), it drives `sigrok-cli`
to capture the Pi's SPI0 header pins, decodes the `//fpga/spi_ws281x` framing, and
prints what it saw — so you can confirm the deployed `led-driver --output=fpga`
really is clocking correct WS281x STREAM frames onto the wire.

    bazel run //pi/tools/la_probe -- --clk D0 --mosi D1 --cs D2 --num-ports 2

Wiring (Raspberry Pi 40-pin header, SPI0 = /dev/spidev0.0):
    SCLK  = pin 23 (GPIO11)  -> LA --clk   (default D0)
    MOSI  = pin 19 (GPIO10)  -> LA --mosi  (default D1)
    CE0   = pin 24 (GPIO8)   -> LA --cs    (default D2)
    GND   = pin  6/9/…       -> LA GND     (share ground!)

NOTE ON CHANNEL NAMES: sigrok names fx2lafw channels D0..D7 (0-based). Many cheap
LAs label their probes CH1..CH8 (1-based), so a probe labelled CHn is sigrok D(n-1)
— e.g. CH2/CH4/CH6 -> --mosi D1 --clk D3 --cs D5. If a capture decodes 0 frames,
unpack the .sr and check which D-channels actually toggle before assuming the wire
is idle.

Requires `sigrok-cli` on PATH (Homebrew: `brew install sigrok-cli`, which pulls
libsigrokdecode). Default capture backend is fx2lafw (the cheap 8-ch FX2 LAs);
override with --driver for a Saleae (`--driver saleae-logic`) etc.

The `spi_ws281x` framing this decodes (see //fpga/spi_ws281x, //pi/led_driver/
led_driver/fpga_spi.py): each CS-low..CS-high transaction is one frame; byte 0 is
an opcode — 0x01 WRITE_CSR (addr, value…) or 0x02 STREAM (round-robin pixel bytes,
byte i -> port i mod num_ports, GRB wire order).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from typing import Dict, List, Optional, Tuple

# --- spi_ws281x protocol (inlined from led_driver.fpga_spi to keep this tool
#     dependency-free — pure stdlib + sigrok-cli, no pydantic/spidev) ---
OP_WRITE_CSR = 0x01
OP_STREAM = 0x02
CSR_NUM_PORTS = 0x00
CSR_LED_TYPE = 0x01
WS_BYTE_US = 10.0
_CSR_NAME = {CSR_NUM_PORTS: "num_ports", CSR_LED_TYPE: "led_type"}

_HEXTOK = re.compile(r"\b([0-9A-Fa-f]{2})\b")


_SIGROK_CANDIDATES = [
    "/opt/homebrew/bin/sigrok-cli",  # Apple Silicon Homebrew
    "/usr/local/bin/sigrok-cli",  # Intel Homebrew / manual
    "/Applications/PulseView.app/Contents/MacOS/sigrok-cli",  # bundled
    "/usr/bin/sigrok-cli",  # Linux distro
]


def _nix_sigrok() -> Optional[str]:
    """Realise sigrok-cli from nixpkgs (no system install needed — same source as
    the Pi image). Returns the binary path, or None if nix is unavailable."""
    import shutil

    nix = shutil.which("nix")
    if not nix:
        return None
    try:
        out = subprocess.run(
            [
                nix,
                "build",
                "--no-link",
                "--print-out-paths",
                "--extra-experimental-features",
                "nix-command flakes",
                "nixpkgs#sigrok-cli",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        store = out.stdout.strip().splitlines()[-1]
        cli = os.path.join(store, "bin", "sigrok-cli")
        return cli if os.path.exists(cli) else None
    except (subprocess.CalledProcessError, IndexError):
        return None


def resolve_sigrok(name: str) -> str:
    """Find sigrok-cli: honor an explicit path/PATH lookup, probe the usual
    macOS/Linux install locations, then fall back to realising it from nixpkgs
    (hostdeploy's env often lacks Homebrew PATH, and we prefer Nix anyway)."""
    import shutil

    if os.path.sep in name and os.path.exists(name):
        return name
    found = shutil.which(name)
    if found:
        return found
    for cand in _SIGROK_CANDIDATES:
        if os.path.exists(cand):
            return cand
    nixed = _nix_sigrok()
    if nixed:
        print(f"[la] using nixpkgs sigrok-cli: {nixed}", file=sys.stderr)
        return nixed
    return name  # let the caller surface the FileNotFoundError with guidance


def matched_speed_hz(num_ports: int) -> int:
    """The rate-matched SPI clock the Pi should use (num_ports * 800 kHz)."""
    return int(num_ports * 8 * 1_000_000 / WS_BYTE_US)


def _resolve_out(path: Optional[str]) -> Optional[str]:
    """Resolve a caller path against bazel's launch dir, so `bazel run` writes it
    where the user expects rather than in the runfiles sandbox."""
    if not path:
        return None
    if os.path.isabs(path):
        return path
    base = os.environ.get("BUILD_WORKING_DIRECTORY", os.getcwd())
    return os.path.join(base, path)


def capture(args: argparse.Namespace, out_sr: str) -> None:
    """Capture a trace from the LA into `out_sr` (a sigrok .sr session)."""
    cmd = [
        args.sigrok_cli,
        "-d",
        args.driver,
        "--config",
        f"samplerate={args.samplerate}",
        "--samples",
        str(args.samples),
        "-o",
        out_sr,
    ]
    if args.trigger and args.cs:
        # Arm on CS falling — the start of a transaction — so a fixed-size grab
        # always lands on a whole frame regardless of the driver's frame cadence.
        # -w makes sigrok wait for the (software) trigger match before sampling.
        cmd += ["--triggers", f"{args.cs}=f", "-w"]
    print(f"[la] capture: {' '.join(cmd)}", file=sys.stderr, flush=True)
    # Hard timeout so a mis-wired trigger / idle wire can never wedge the caller.
    proc = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, timeout=args.timeout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, flush=True)
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, stderr=proc.stderr)


def decode(args: argparse.Namespace, in_sr: str, annotation: str) -> str:
    """Run the sigrok SPI decoder over `in_sr`, emitting one annotation class."""
    spi = f"spi:clk={args.clk}:mosi={args.mosi}:cpol=0:cpha=0"
    if args.cs:
        spi += f":cs={args.cs}"
    cmd = [args.sigrok_cli, "-i", in_sr, "-P", spi, "-A", f"spi={annotation}"]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=args.timeout)
    return out.stdout


def _frames_from_transfers(stdout: str) -> List[List[int]]:
    """Each `mosi-transfer` line groups one CS transaction's bytes -> a frame."""
    frames: List[List[int]] = []
    for line in stdout.splitlines():
        toks = _HEXTOK.findall(line.split(":", 1)[1] if ":" in line else line)
        if toks:
            frames.append([int(t, 16) for t in toks])
    return frames


def _bytes_from_data(stdout: str) -> List[int]:
    """`mosi-data` prints one byte per line -> the flat MOSI byte stream."""
    out: List[int] = []
    for line in stdout.splitlines():
        toks = _HEXTOK.findall(line.split(":", 1)[1] if ":" in line else line)
        if toks:
            out.append(int(toks[-1], 16))
    return out


def _deinterleave(payload: List[int], num_ports: int) -> List[List[Tuple[int, int, int]]]:
    """Invert the round-robin STREAM transpose: byte i -> port i mod num_ports,
    then each port's bytes are GRB triples -> RGB pixels."""
    per_port_bytes: List[List[int]] = [[] for _ in range(num_ports)]
    for i, b in enumerate(payload):
        per_port_bytes[i % num_ports].append(b)
    ports: List[List[Tuple[int, int, int]]] = []
    for pb in per_port_bytes:
        px = [(pb[j + 1], pb[j], pb[j + 2]) for j in range(0, len(pb) - 2, 3)]  # (g,r,b)->RGB
        ports.append(px)
    return ports


def classify(frames: List[List[int]], num_ports: int) -> Dict:
    """Turn raw frames into a structured, validated report."""
    report: Dict = {"num_ports_expected": num_ports, "frames": [], "notes": [], "ok": True}
    csr_ports: Optional[int] = None
    stream_lens = set()
    for f in frames:
        if not f:
            continue
        op = f[0]
        if op == OP_WRITE_CSR and len(f) >= 3:
            addr, val = f[1], f[2]
            name = _CSR_NAME.get(addr, f"0x{addr:02x}")
            if addr == CSR_NUM_PORTS:
                csr_ports = val
            report["frames"].append({"kind": "csr", "addr": name, "value": val, "raw": f})
        elif op == OP_STREAM:
            payload = f[1:]
            stream_lens.add(len(payload))
            entry: Dict = {"kind": "stream", "payload_len": len(payload), "raw": f}
            if num_ports and len(payload) % num_ports == 0:
                ports = _deinterleave(payload, num_ports)
                entry["leds_per_port"] = len(ports[0]) if ports else 0
                entry["ports"] = ports
            else:
                report["notes"].append(
                    f"stream payload {len(payload)}B not divisible by num_ports={num_ports}"
                )
                report["ok"] = False
            report["frames"].append(entry)
        else:
            report["frames"].append({"kind": "unknown", "raw": f})
            report["notes"].append(f"unrecognized opcode 0x{op:02x} (frame {f[:4]}…)")
            report["ok"] = False

    if csr_ports is not None and csr_ports != num_ports:
        report["notes"].append(f"CSR num_ports={csr_ports} != expected {num_ports}")
        report["ok"] = False
    report["csr_num_ports"] = csr_ports
    report["stream_frame_lens"] = sorted(stream_lens)
    report["stream_count"] = sum(1 for f in report["frames"] if f["kind"] == "stream")
    return report


def _print_report(report: Dict, max_frames: int) -> None:
    np = report["num_ports_expected"]
    print(f"\n=== spi_ws281x wire report (expect num_ports={np}) ===")
    print(f"matched SPI clock for {np} ports: {matched_speed_hz(np):,} Hz")
    csr = report.get("csr_num_ports")
    print(
        f"CSR num_ports on wire: {csr if csr is not None else '(not captured — no reset window)'}"
    )
    print(
        f"STREAM frames: {report['stream_count']}  frame payload sizes: {report['stream_frame_lens']}"
    )
    shown = 0
    for fr in report["frames"]:
        if shown >= max_frames:
            print(f"  … ({len(report['frames']) - shown} more frames)")
            break
        if fr["kind"] == "csr":
            print(f"  CSR  {fr['addr']} = {fr['value']}   raw={_hex(fr['raw'])}")
        elif fr["kind"] == "stream":
            ports = fr.get("ports")
            head = ""
            if ports:
                head = "  ".join(
                    f"p{i}:{px[:2]}{'…' if len(px) > 2 else ''}" for i, px in enumerate(ports)
                )
            lpp = fr.get("leds_per_port", "?")
            print(f"  STREAM {fr['payload_len']}B  leds/port={lpp}  {head}")
        else:
            print(f"  ????  raw={_hex(fr['raw'])}")
        shown += 1
    for n in report["notes"]:
        print(f"  ! {n}")
    print(
        f"\nRESULT: {'PASS ✓' if report['ok'] and report['stream_count'] else 'FAIL ✗'}"
        f" ({report['stream_count']} stream frame(s) decoded)"
    )


def _hex(bs: List[int]) -> str:
    return " ".join(f"{b:02x}" for b in bs)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--driver", default="fx2lafw", help="sigrok capture driver (default fx2lafw)")
    ap.add_argument("--samplerate", default="12m", help="capture sample rate (default 12m)")
    ap.add_argument(
        "--samples", type=int, default=3_000_000, help="samples to capture (~250ms @12m)"
    )
    ap.add_argument("--clk", default="D0", help="LA channel on SPI SCLK (Pi pin 23)")
    ap.add_argument("--mosi", default="D1", help="LA channel on SPI MOSI (Pi pin 19)")
    ap.add_argument(
        "--cs", default="D2", help="LA channel on SPI CE0 (Pi pin 24); '' = no CS framing"
    )
    # Trigger is OFF by default: a mis-wired/idle CS with -w streams forever. A big
    # free-run buffer spans several frames regardless of cadence, and can't hang.
    ap.add_argument(
        "--trigger",
        dest="trigger",
        action="store_true",
        help="arm on CS-falling (-w); only if CS is confirmed toggling",
    )
    ap.add_argument("--timeout", type=float, default=90.0, help="hard cap (s) on each sigrok call")
    ap.add_argument("--num-ports", type=int, default=2, help="expected FPGA num_ports")
    ap.add_argument("--sr-in", help="decode this existing .sr instead of capturing")
    ap.add_argument("--sr-out", help="also save the captured .sr here (open in PulseView)")
    ap.add_argument("--json-out", help="write the structured report as JSON")
    ap.add_argument("--max-frames", type=int, default=12, help="frames to print")
    ap.add_argument("--sigrok-cli", default="sigrok-cli", help="path to sigrok-cli")
    ap.add_argument("--scan", action="store_true", help="just list detected LA hardware and exit")
    args = ap.parse_args(argv)
    args.sigrok_cli = resolve_sigrok(args.sigrok_cli)

    if args.scan:
        try:
            out = subprocess.run(
                [args.sigrok_cli, "--scan"], check=True, capture_output=True, text=True
            )
            print(out.stdout or "(no devices found)")
            ver = subprocess.run(
                [args.sigrok_cli, "--version"], capture_output=True, text=True
            ).stdout
            print(f"(sigrok version)\n{ver}")
            return 0
        except FileNotFoundError as e:
            print(f"[la] {e} — is sigrok-cli installed and on PATH?", file=sys.stderr)
            return 2

    tmp = None
    try:
        if args.sr_in:
            in_sr = _resolve_out(args.sr_in)
        else:
            in_sr = _resolve_out(args.sr_out)
            if in_sr is None:
                tmp = tempfile.NamedTemporaryFile(suffix=".sr", delete=False)
                tmp.close()
                in_sr = tmp.name
            capture(args, in_sr)

        transfers = decode(args, in_sr, "mosi-transfer")
        frames = _frames_from_transfers(transfers)
        if not frames and args.cs:
            print("[la] no CS-framed transfers; falling back to flat mosi-data", file=sys.stderr)
            flat = _bytes_from_data(decode(args, in_sr, "mosi-data"))
            frames = [flat] if flat else []

        report = classify(frames, args.num_ports)
        report["raw_hex"] = _hex(_bytes_from_data(decode(args, in_sr, "mosi-data")))
        _print_report(report, args.max_frames)

        jout = _resolve_out(args.json_out)
        if jout:
            with open(jout, "w") as fh:
                json.dump(report, fh, indent=2)
            print(f"[la] wrote {jout}", file=sys.stderr)
        return 0 if (report["ok"] and report["stream_count"]) else 1
    except FileNotFoundError as e:
        print(f"[la] {e} — is sigrok-cli installed and on PATH?", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print(
            f"[la] sigrok-cli timed out after {args.timeout}s (idle wire? wrong channels?)",
            file=sys.stderr,
        )
        return 2
    except subprocess.CalledProcessError as e:
        print(f"[la] sigrok-cli failed (rc={e.returncode})", file=sys.stderr)
        return e.returncode or 2
    finally:
        if tmp is not None:
            os.unlink(tmp.name)


if __name__ == "__main__":
    raise SystemExit(main())
