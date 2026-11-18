#!/usr/bin/env python3
"""Chart for Q25 (containing an insider that floods forged live moves, design §7.9).

    TREE_SET=quarantine treesweep > tree-quarantine.csv
    python3 plot_quarantine.py tree-quarantine.csv OUT

Writes tree-quarantine.png. Needs matplotlib.
"""
import csv
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

DEF = (
    ("0", "no containment", "0.6"),
    ("1", "local blocks", "tab:orange"),
    ("3", "local + gateway quorum", "tab:purple"),
    ("2", "gateway quorum (recommended)", "tab:green"),
)


def pick(rows, n, guard, relay, spoof="false", framers="0", hz="30"):
    for x in rows:
        if (
            x["n"] == n
            and x["guard"] == guard
            and x["insider_relay"] == relay
            and x["spoof"] == spoof
            and x["framers"] == framers
            and x["insider_hz"] == hz
        ):
            return x
    return None


def main():
    rows = list(csv.DictReader(open(sys.argv[1])))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    fig, ax = plt.subplots(1, 3, figsize=(16, 4))
    groups = [(n, relay) for n in ("64", "128") for relay in ("false", "true")]
    w = 0.2
    for k, (g, lab, col) in enumerate(DEF):
        dl, p50, lf = [], [], []
        for n, relay in groups:
            r = pick(rows, n, g, relay)
            dl.append(float(r["delivery"]))
            p50.append(float(r["lat_p50_ms"]))
            lf.append(int(r["local_false"]))
        xs = [i + (k - 1.5) * w for i in range(len(groups))]
        ax[0].bar(xs, dl, w, color=col, label=lab)
        ax[1].bar(xs, p50, w, color=col)
        ax[2].bar(xs, lf, w, color=col)
    names = [f"{n} fixtures\n{'relay' if r == 'true' else 'leaf'} insider" for n, r in groups]
    for a in ax:
        a.set_xticks(range(len(groups)))
        a.set_xticklabels(names, fontsize=7)
    ax[0].set_ylim(0.6, 1.0)
    ax[0].legend(fontsize=6, loc="lower left")
    ax[0].set_title("live delivered while an insider forges at 30 Hz", fontsize=8)
    ax[1].set_yscale("log")
    ax[1].set_title("live latency p50 (ms)", fontsize=8)
    ax[2].set_title("honest (fixture, neighbour) blocks in force at the end", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-quarantine.png"), dpi=110)


if __name__ == "__main__":
    main()
