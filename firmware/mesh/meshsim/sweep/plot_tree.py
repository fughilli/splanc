#!/usr/bin/env python3
"""Charts for the two-tier distribution tree (design §5.8).

    treesweep > tree.csv
    python3 plot_tree.py tree.csv OUT_DIR

Writes tree-scale.png and tree-dynamics.png. Needs matplotlib.
"""
import csv
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def load(p):
    with open(p) as f:
        return list(csv.DictReader(f))


SERIES = (
    ("Flood", "0", "managed flood", "k", "s-"),
    ("Tree", "0", "tree, no UWB", "tab:blue", "o-"),
    ("Tree", "0.5", "tree, 50 % UWB", "tab:orange", "o-"),
    ("Tree", "1", "tree, all UWB", "tab:green", "o-"),
)


def main():
    rows, out = load(sys.argv[1]), sys.argv[2]
    os.makedirs(out, exist_ok=True)

    scale = [r for r in rows if r["sweep"] == "scale"]
    fig, ax = plt.subplots(1, 4, figsize=(16, 3.8))
    for scheme, frac, lab, col, st in SERIES:
        pts = sorted(
            (int(r["n"]), r)
            for r in scale
            if r["scheme"] == scheme and (scheme == "Flood" or r["uwb_frac"] == frac)
        )
        xs = [p[0] for p in pts]
        ax[0].plot(xs, [float(p[1]["delivery"]) for p in pts], st, color=col, label=lab)
        ax[1].plot(xs, [float(p[1]["lat_p99_ms"]) for p in pts], st, color=col)
        ax[2].plot(xs, [float(p[1]["wifi_airtime"]) for p in pts], st, color=col)
        ax[3].plot(xs, [float(p[1]["parent_changes_per_node_min"]) for p in pts], st, color=col)
    ax[0].axhline(0.99, color="k", ls=":")
    ax[0].set_title("live updates delivered (30 Hz, 3 % loss, walking)", fontsize=8)
    ax[0].legend(fontsize=6)
    ax[1].set_yscale("log")
    ax[1].set_title("latency p99 (ms)", fontsize=8)
    ax[2].set_title("802.11 airtime (sum over nodes / run time)", fontsize=8)
    ax[3].set_title("parent changes per node-minute", fontsize=8)
    for a in ax:
        a.set_xscale("log", base=2)
        a.set_xticks([6, 16, 32, 64, 128])
        a.set_xticklabels(["6", "16", "32", "64", "128"])
        a.set_xlabel("fixtures", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-scale.png"), dpi=110)

    dyn = [r for r in rows if r["sweep"] == "dynamics"]
    conds = [("false", "0"), ("true", "0"), ("false", "0.25"), ("true", "0.25")]
    names = ["still", "walking", "25 % moving", "walking + moving"]
    variants = (
        ("Flood", "true", "managed flood", "0.6"),
        ("Tree", "false", "tree, subtree MACs", "tab:red"),
        ("Tree", "true", "tree, full MACs", "tab:green"),
    )
    fig, ax = plt.subplots(1, 3, figsize=(14, 3.8))
    w = 0.27
    for k, (scheme, full, lab, col) in enumerate(variants):
        vals = []
        for walk, mov in conds:
            r = next(
                x
                for x in dyn
                if x["scheme"] == scheme
                and x["full_macs"] == full
                and x["walking"] == walk
                and float(x["moving"]) == float(mov)
            )
            vals.append(r)
        xs = [i + (k - 1) * w for i in range(len(conds))]
        ax[0].bar(xs, [float(v["delivery"]) for v in vals], w, color=col, label=lab)
        ax[1].bar(xs, [float(v["wifi_airtime"]) for v in vals], w, color=col)
        ax[2].bar(xs, [float(v["lat_p99_ms"]) for v in vals], w, color=col)
    ax[0].set_ylim(0.8, 1.005)
    ax[0].set_title("live delivered, 32 fixtures, 50 % UWB", fontsize=8)
    ax[0].legend(fontsize=6, loc="lower left")
    ax[1].set_title("802.11 airtime", fontsize=8)
    ax[2].set_title("latency p99 (ms)", fontsize=8)
    for a in ax:
        a.set_xticks(range(len(conds)))
        a.set_xticklabels(names, fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-dynamics.png"), dpi=110)


if __name__ == "__main__":
    main()
