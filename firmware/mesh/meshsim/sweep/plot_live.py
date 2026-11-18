#!/usr/bin/env python3
"""Chart for Q22 (live latency above 24 members, design §7.9).

    TREE_SET=live treesweep > tree-live.csv
    python3 plot_live.py tree-live.csv OUT

Writes tree-live.png. Needs matplotlib.
"""
import csv
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OPTS = (
    ("per-receiver MACs", lambda x: x["tesla"] == "none", "0.6"),
    (
        "verify-first, d = 3",
        lambda x: x["tesla"] == "20ms/d3" and x["adaptive"] == "false",
        "tab:blue",
    ),
    (
        "verify-first, adaptive d",
        lambda x: x["tesla"] == "20ms/d3" and x["adaptive"] == "true" and x["early"] == "false",
        "tab:cyan",
    ),
    (
        "apply-then-verify, adaptive d",
        lambda x: x["tesla"] == "20ms/d3" and x["early"] == "true" and x["insider_hz"] == "0",
        "tab:green",
    ),
    (
        "apply-then-verify, insider 1 Hz",
        lambda x: x["early"] == "true" and x["insider_hz"] == "1",
        "tab:orange",
    ),
    (
        "apply-then-verify, insider 30 Hz",
        lambda x: x["early"] == "true" and x["insider_hz"] == "30",
        "tab:red",
    ),
)


def main():
    rows = list(csv.DictReader(open(sys.argv[1])))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    ns = ["32", "64", "128"]
    fig, ax = plt.subplots(1, 3, figsize=(16, 4))
    w = 0.13
    for k, (lab, f, col) in enumerate(OPTS):
        p50, p99, dl = [], [], []
        for n in ns:
            r = next(x for x in rows if x["n"] == n and f(x))
            p50.append(float(r["lat_p50_ms"]))
            p99.append(float(r["lat_p99_ms"]))
            dl.append(float(r["delivery"]))
        xs = [i + (k - 2.5) * w for i in range(len(ns))]
        ax[0].bar(xs, p50, w, color=col, label=lab)
        ax[0].scatter(xs, p99, color=col, marker="_", s=120)
        ax[1].bar(xs, dl, w, color=col)
    ax[0].axhspan(5, 20, color="tab:green", alpha=0.08)
    ax[0].set_yscale("log")
    ax[0].set_title(
        "live latency p50 (bars) and p99 (ticks), ms; shaded: the 5-20 ms target", fontsize=8
    )
    ax[0].legend(fontsize=6, loc="upper left")
    ax[1].set_ylim(0.6, 1.005)
    ax[1].set_title("live updates delivered", fontsize=8)
    for a in ax[:2]:
        a.set_xticks(range(len(ns)))
        a.set_xticklabels([f"{n} fixtures" for n in ns], fontsize=8)
    # Insider effect under apply-then-verify.
    labels, gmax, g50, share = [], [], [], []
    for n in ns:
        for hz in ("1", "30"):
            r = next(
                x for x in rows if x["n"] == n and x["early"] == "true" and x["insider_hz"] == hz
            )
            labels.append(f"{n}\n{hz} Hz")
            gmax.append(float(r["glitch_max_ms"]))
            g50.append(float(r["glitch_p50_ms"]))
            share.append(float(r["forged_screen_share"]) * 100)
    xs = range(len(labels))
    ax[2].bar(
        [x - 0.2 for x in xs],
        g50,
        0.4,
        color="tab:orange",
        label="forged value on screen, p50 (ms)",
    )
    ax[2].bar([x + 0.2 for x in xs], gmax, 0.4, color="tab:red", label="max (ms)")
    for x, sh in zip(xs, share):
        ax[2].text(x, max(gmax) * 1.02, f"{sh:.2f} %", ha="center", fontsize=6)
    ax[2].set_xticks(list(xs))
    ax[2].set_xticklabels(labels, fontsize=7)
    ax[2].legend(fontsize=6, loc="upper left")
    ax[2].set_title(
        "an insider forging: glitch length; label: share of member screen time", fontsize=8
    )
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-live.png"), dpi=110)


if __name__ == "__main__":
    main()
