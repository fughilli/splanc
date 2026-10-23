#!/usr/bin/env python3
"""Flash the FX perf-study bench image (//firmware/fx_perf_bench) on a HITL C6
and capture its `fxpb ...` result lines (docs/design/fx-perf-study.md).

One atomic reservation: reserve → scp the flash bundle → `hitl-flash --monitor`
for --seconds → release. The image prints every result as it goes AND re-dumps
the full log every ~6 s once done, so the parse takes the last complete dump
(falling back to the streamed lines). The raw serial is always saved.

  python3 tools/fx_perf/run_bench.py --bundle bazel-bin/firmware/fx_perf_bench/fx_perf_bench_flashbundle.tar \
      --out runs/bench.log --seconds 420 [--server http://hitl-rig-3:8087] [--device c6-117d10]
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "pi", "hitl", "harness"))


def parse(text: str) -> list[str]:
    """The `fxpb` result lines from a capture: the last complete dump, else every
    streamed line (deduplicated, in order)."""
    lines = [ln.strip() for ln in text.splitlines()]
    begins = [i for i, ln in enumerate(lines) if ln.endswith("fxpb-dump BEGIN")]
    for b in reversed(begins):
        try:
            e = next(i for i in range(b, len(lines)) if lines[i].endswith("fxpb-dump END"))
        except StopIteration:
            continue
        return [ln[ln.index("fxpb ") :] for ln in lines[b + 1 : e] if "fxpb " in ln]
    seen, out = set(), []
    for ln in lines:
        if "fxpb " in ln and "fxpb-dump" not in ln:
            ln = ln[ln.index("fxpb ") :]
            if ln not in seen:
                seen.add(ln)
                out.append(ln)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--out", required=True, help="parsed fxpb lines (raw serial goes to <out>.raw)")
    ap.add_argument("--seconds", type=float, default=420)
    ap.add_argument("--server", default=None)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    import hitl_client

    res = hitl_client.Reservation(
        server=args.server,
        sku="esp32c6",
        device=args.device,
        owner=os.environ.get("HITL_OWNER", "agent-fx-perf-study"),
    )
    try:
        res.acquire()
    except BaseException:
        # e.g. a SIGTERM while queued: never leave an orphaned reservation holding a
        # queue slot on a shared rig.
        res.release()
        raise
    try:
        raw = ""
        # esptool's "chip stopped responding" / serial-noise flash flake is common on
        # the shared rigs (memory: hitl-flash doesn't retry) — retry the whole flash.
        for attempt in range(3):
            remote = f"/tmp/fxpb-{uuid.uuid4().hex}.tar"
            res.scp_to([args.bundle], remote)
            p = res.ssh(
                f"hitl-flash {remote} --monitor --monitor-seconds {args.seconds:g}",
                capture=True,
                timeout=args.seconds + 240,
            )
            raw = (p.stdout or "") + (p.stderr or "")
            if "fxpb boot" in raw:
                break
            print(f"flash attempt {attempt + 1} produced no bench output; retrying", flush=True)
    finally:
        res.release()
    with open(args.out + ".raw", "w") as f:
        f.write(raw)
    lines = parse(raw)
    with open(args.out, "w") as f:
        f.write("\n".join(lines) + "\n")
    done = any(ln.strip() == "fxpb done" for ln in lines)
    print(f"{len(lines)} result lines, complete={done} -> {args.out}")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
