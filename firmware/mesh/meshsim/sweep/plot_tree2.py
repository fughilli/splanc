#!/usr/bin/env python3
"""Charts for the owner's Q18-Q21 answers on the distribution tree (design §5.8, §7.9).

    TREE_SET=switch SERIES_OUT=switch-series.csv treesweep > tree-switch.csv
    TREE_SET=auth treesweep > tree-auth.csv
    TREE_SET=uwbhop treesweep > tree-uwbhop.csv
    TREE_SET=cache treesweep > tree-cache.csv
    python3 plot_tree2.py switch-series.csv tree-auth.csv tree-uwbhop.csv tree-cache.csv OUT

Writes tree-switch.png, tree-auth.png, tree-uwbhop.png and tree-cache.png. Needs matplotlib.
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


def switch(rows, out):
    fig, ax = plt.subplots(2, 1, figsize=(12, 5.5), sharex=True)
    for sch, col in (("Flood", "0.5"), ("Tree", "tab:blue"), ("Auto", "tab:green")):
        r = [x for x in rows if x["scheme"] == sch]
        t = [float(x["t_s"]) for x in r]
        ax[0].plot(
            t,
            [float(x["delivery"]) for x in r],
            color=col,
            label=sch.lower() if sch != "Auto" else "automatic",
        )
        ax[1].plot(t, [float(x["airtime"]) for x in r], color=col)
    auto = [x for x in rows if x["scheme"] == "Auto"]
    for x in auto:
        if x["tree"] == "1":
            for a in ax:
                a.axvspan(
                    float(x["t_s"]) - 0.5,
                    float(x["t_s"]) + 0.5,
                    color="tab:green",
                    alpha=0.08,
                    lw=0,
                )
    ax2 = ax[0].twinx()
    ax2.step(
        [float(x["t_s"]) for x in auto], [int(x["members"]) for x in auto], "k:", where="mid", lw=1
    )
    ax2.set_ylabel("members", fontsize=8)
    for y in (16, 24):
        ax2.axhline(y, color="k", lw=0.5, alpha=0.3)
    ax[0].set_ylim(0.9, 1.005)
    ax[0].set_title(
        "live updates delivered per second (shaded: automatic mode on the tree; dotted: members, thresholds 16/24)",
        fontsize=8,
    )
    ax[0].legend(fontsize=7, loc="lower left")
    ax[1].set_title("802.11 airtime per second", fontsize=8)
    ax[1].set_xlabel("s after warm-up", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-switch.png"), dpi=110)


def auth(rows, out):
    fig, ax = plt.subplots(1, 4, figsize=(17, 3.8))
    series = (
        ("flood, per-receiver MACs", lambda x: x["scheme"] == "Flood", "k", "s-"),
        (
            "tree, per-receiver MACs",
            lambda x: x["scheme"] == "Tree" and x["tesla"] == "none",
            "tab:blue",
            "o-",
        ),
        (
            "tree, authenticator 20 ms / d3",
            lambda x: x["tesla"] == "20ms/d3" and x["rtt"] == "40" and x["uwb_frac"] == "0.5",
            "tab:green",
            "o-",
        ),
        (
            "tree, authenticator 10 ms / d4",
            lambda x: x["tesla"] == "10ms/d4" and x["uwb_frac"] == "0.5",
            "tab:olive",
            "o--",
        ),
    )
    for lab, f, col, st in series:
        pts = sorted((int(x["n"]), x) for x in rows if f(x))
        xs = [p[0] for p in pts]
        ax[0].plot(xs, [float(p[1]["delivery"]) for p in pts], st, color=col, label=lab)
        ax[1].plot(xs, [float(p[1]["lat_p99_ms"]) for p in pts], st, color=col)
        ax[2].plot(xs, [float(p[1]["wifi_airtime"]) for p in pts], st, color=col)
    ax[0].set_title("live delivered, 30 Hz, 50 % UWB", fontsize=8)
    ax[0].legend(fontsize=6)
    ax[1].set_yscale("log")
    ax[1].set_title("latency p99 (ms)", fontsize=8)
    ax[2].set_title("802.11 airtime", fontsize=8)
    for a in ax[:3]:
        a.set_xscale("log", base=2)
        a.set_xticks([32, 64, 128])
        a.set_xticklabels(["32", "64", "128"])
        a.set_xlabel("fixtures", fontsize=8)
    # Delivery vs disclosure delay and bootstrap round trip, 64 fixtures.
    labels, vals = [], []
    for t, rtt in (
        ("20ms/d2", "40"),
        ("20ms/d3", "40"),
        ("20ms/d4", "40"),
        ("10ms/d4", "40"),
        ("10ms/d6", "40"),
        ("20ms/d3", "100"),
    ):
        r = next(
            (
                x
                for x in rows
                if x["n"] == "64" and x["tesla"] == t and x["rtt"] == rtt and x["uwb_frac"] == "0.5"
            ),
            None,
        )
        if r:
            labels.append(f"{t}\nRTT {rtt} ms")
            vals.append(float(r["delivery"]))
    ax[3].bar(range(len(vals)), vals, color=["tab:red" if v < 0.98 else "tab:green" for v in vals])
    ax[3].set_xticks(range(len(vals)))
    ax[3].set_xticklabels(labels, fontsize=6)
    ax[3].set_title("64 fixtures: interval / d vs bootstrap round trip", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-auth.png"), dpi=110)


def uwbhop(rows, out):
    fig, ax = plt.subplots(1, 3, figsize=(14, 3.8))
    groups = []
    for n in ("64", "128"):
        for tesla in ("none", "20ms/d3"):
            for frac in ("0.5", "1"):
                groups.append((n, tesla, frac))
    w = 0.38
    for k, mh in enumerate(("false", "true")):
        d, a, u = [], [], []
        for n, tesla, frac in groups:
            r = next(
                x
                for x in rows
                if x["n"] == n
                and x["tesla"] == tesla
                and x["uwb_frac"] == frac
                and x["multihop"] == mh
                and x["scheme"] == "Tree"
            )
            d.append(float(r["delivery"]))
            a.append(float(r["wifi_airtime"]))
            u.append(float(r["uwb_util"]))
        xs = [i + (k - 0.5) * w for i in range(len(groups))]
        lab = "multi-hop UWB" if mh == "true" else "one-hop UWB (root only)"
        col = "tab:purple" if mh == "true" else "0.6"
        ax[0].bar(xs, d, w, color=col, label=lab)
        ax[1].bar(xs, a, w, color=col)
        ax[2].bar(xs, u, w, color=col)
    names = [
        f"{n}\n{'MACs' if t == 'none' else 'auth'}\n{int(float(f) * 100)} % UWB"
        for n, t, f in groups
    ]
    for a in ax:
        a.set_xticks(range(len(groups)))
        a.set_xticklabels(names, fontsize=6)
    ax[0].set_ylim(0.7, 1.005)
    ax[0].legend(fontsize=6, loc="lower left")
    ax[0].set_title("live delivered", fontsize=8)
    ax[1].set_yscale("log")
    ax[1].set_title("802.11 airtime", fontsize=8)
    ax[2].set_title("UWB utilisation", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-uwbhop.png"), dpi=110)


def cache(rows, out):
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.6))
    for n, col in (("32", "tab:blue"), ("64", "tab:orange")):
        for loss, st in (("0.03", "o-"), ("0.1", "s--"), ("0.2", "^:")):
            r = sorted((int(x["depth"]), x) for x in rows if x["n"] == n and x["loss"] == loss)
            xs = [p[0] for p in r]
            hit = [
                int(p[1]["cache_hits"])
                / max(1, int(p[1]["cache_hits"]) + int(p[1]["cache_misses"]))
                for p in r
            ]
            ax[0].plot(
                xs, hit, st, color=col, label=f"{n} fixtures, {float(loss) * 100:.0f} % loss"
            )
            ax[1].plot(xs, [float(p[1]["reliable_delivery"]) for p in r], st, color=col)
    ax[0].set_title("repair requests answered from the cache", fontsize=8)
    ax[0].legend(fontsize=6)
    ax[1].set_title("reliable commands delivered (1 s)", fontsize=8)
    for a in ax:
        a.set_xscale("log", base=2)
        a.set_xticks([1, 2, 4, 8, 16])
        a.set_xticklabels(["1", "2", "4", "8", "16"])
        a.set_xlabel("cache entries", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, "tree-cache.png"), dpi=110)


def main():
    sw, au, uh, ca, out = sys.argv[1:6]
    os.makedirs(out, exist_ok=True)
    switch(load(sw), out)
    auth(load(au), out)
    uwbhop(load(uh), out)
    cache(load(ca), out)


if __name__ == "__main__":
    main()
