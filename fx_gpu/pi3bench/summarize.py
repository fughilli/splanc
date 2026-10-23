#!/usr/bin/env python3
"""Summarise pi3bench JSON lines (stdin or files) into a table per layout."""
import json
import sys


def rows(stream):
    for line in stream:
        line = line.strip()
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except ValueError:
                pass


def main():
    srcs = [open(p) for p in sys.argv[1:]] or [sys.stdin]
    recs = [r for s in srcs for r in rows(s)]
    for r in recs:
        if r.get("bench") == "env":
            print("env:", {k: v for k, v in r.items() if k != "bench"})
    gl = {(r["kernel"], r["layout"]): r for r in recs if r.get("bench") == "gles2" and r.get("ok")}
    vm = {(r["kernel"], r["layout"]): r for r in recs if r.get("bench") == "vm"}
    for r in recs:
        if r.get("bench") == "gles2" and not r.get("ok"):
            print("gles2 FAIL:", r)
    hdr = "%-14s %-8s %6s %9s %9s %9s %8s %8s %10s" % (
        "kernel",
        "layout",
        "n",
        "render",
        "readback",
        "pipe",
        "gpuErr",
        "vm_ms",
        "vm/gpu",
    )
    print(hdr)
    for key in sorted(set(gl) | set(vm), key=lambda k: (k[0], vm.get(k, gl.get(k))["n"])):
        g, v = gl.get(key), vm.get(key)
        n = (g or v)["n"]
        gpu = (g["render_ms_median"] + g["readback_ms_median"]) if g else None
        print(
            "%-14s %-8s %6d %9s %9s %9s %8s %8s %10s"
            % (
                key[0],
                key[1],
                n,
                "%.2f" % g["render_ms_median"] if g else "-",
                "%.2f" % g["readback_ms_median"] if g else "-",
                "%.2f" % g["pipelined_ms_median"] if g else "-",
                "%d/%d" % (g["golden_max_err"], g["golden_mismatch_leds"]) if g else "-",
                "%.2f" % v["ms_median"] if v else "-",
                "%.1fx" % (v["ms_median"] / gpu) if (g and v and gpu > 0) else "-",
            )
        )


if __name__ == "__main__":
    main()
