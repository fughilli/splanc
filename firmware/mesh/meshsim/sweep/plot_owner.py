#!/usr/bin/env python3
"""Charts for the owner's Q12/Q13/Q15 answers (design §4.6, §6.4, §10.6).

    SWEEP_SET=live   sweep > live.csv
    SWEEP_SET=rate   sweep > rate.csv
    SWEEP_SET=stress sweep > stress.csv
    python3 plot_owner.py live.csv rate.csv stress.csv OUT_DIR

Writes live-rate.png, phy-rate.png and hops.png. Needs matplotlib.
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


def main():
    live, rate, stress, out = load(sys.argv[1]), load(sys.argv[2]), load(sys.argv[3]), sys.argv[4]
    os.makedirs(out, exist_ok=True)

    fig, ax = plt.subplots(1, 3, figsize=(14, 3.8))
    for n, col in (("6", "tab:blue"), ("16", "tab:orange"), ("32", "tab:green")):
        for ad, st in (("true", "o-"), ("false", "x--")):
            pts = sorted(
                (
                    int(x["traffic"][4:]),
                    float(x["delivery"]),
                    float(x["rms_hauto"]),
                    float(x["live_eff_hz"]),
                )
                for x in live
                if x["n"] == n and x["adaptive"] == ad
            )
            lab = f"{n} nodes, {'adaptive' if ad == 'true' else 'fixed 6 Mb/s'}"
            ax[0].plot([p[0] for p in pts], [p[1] for p in pts], st, color=col, label=lab)
            ax[1].plot([p[0] for p in pts], [p[3] for p in pts], st, color=col)
            ax[2].plot([p[0] for p in pts], [p[2] for p in pts], st, color=col)
    ax[0].axhline(0.99, color="k", ls=":")
    ax[0].set_title("live updates delivered (5 % loss, people walking)", fontsize=8)
    ax[0].legend(fontsize=6)
    ax[1].plot([15, 120], [15, 120], "k:")
    ax[1].set_title("updates/s each member receives (coalesced)", fontsize=8)
    ax[2].set_yscale("log")
    ax[2].set_title(
        "rendered error, Hermite at the auto playout delay (RMS, full scale)", fontsize=8
    )
    for a in ax:
        a.set_xlabel("offered rate (Hz)", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "live-rate.png"), dpi=110)

    fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
    labels = ["1", "6", "12", "24", "adaptive"]
    for k, (walk, title) in enumerate(
        (("false", "30 Hz live: delivery, mixed links"), ("true", "same, people walking"))
    ):
        for j, n in enumerate(["6", "16", "32"]):
            ys = []
            for lab in labels:
                v = [
                    float(x["delivery"])
                    for x in rate
                    if x["n"] == n
                    and x["walking"] == walk
                    and (
                        (lab == "adaptive" and x["adaptive"] == "true")
                        or (
                            x["adaptive"] == "false"
                            and lab != "adaptive"
                            and abs(float(x["mean_mbps"]) - float(lab)) < 0.01
                        )
                    )
                ]
                ys.append(v[0] if v else 0)
            ax[k].bar([i + j * 0.27 for i in range(5)], ys, 0.27, label=f"{n} nodes")
        ax[k].set_xticks([i + 0.27 for i in range(5)])
        ax[k].set_xticklabels(["1 Mb/s", "6 Mb/s", "12 Mb/s", "24 Mb/s", "adaptive"], fontsize=8)
        ax[k].set_ylim(0, 1.05)
        ax[k].set_title(title, fontsize=9)
    ax[0].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "phy-rate.png"), dpi=110)

    fig, ax = plt.subplots(figsize=(7, 3.6))
    tops = ["Line", "Clustered", "Grid", "Random"]
    for j, (h, lab) in enumerate(
        (("3", "fixed 3"), ("5", "fixed 5"), ("7", "fixed 7"), ("0", "adaptive"))
    ):
        ys = [
            float(
                next(
                    x["delivery"]
                    for x in stress
                    if x["sweep"] == "hops" and x["topology"] == t and x["hop"] == h
                )
            )
            for t in tops
        ]
        ax.bar([i + j * 0.2 for i in range(4)], ys, 0.2, label=lab)
    ax.set_xticks([i + 0.3 for i in range(4)])
    ax.set_xticklabels([t + ", 32 nodes" for t in tops], fontsize=8)
    ax.set_ylim(0, 1.05)
    ax.set_title("30 Hz control delivery: fixed vs adaptive hop limit (6 Mb/s)", fontsize=9)
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "hops.png"), dpi=110)


if __name__ == "__main__":
    main()
