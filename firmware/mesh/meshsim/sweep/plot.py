#!/usr/bin/env python3
"""Plots and a compact table from the meshsim capacity sweep (design §10.6).

    python3 plot.py sweep.csv OUT_DIR [PREFIX]

Writes OUT_DIR/PREFIXmix.png, nodes.png, topology.png, loss.png, queues.png and
OUT_DIR/PREFIXsummary.md. Needs matplotlib.
"""
import csv
import math
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def load(path):
    with open(path) as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for k, v in r.items():
            try:
                r[k] = float(v)
            except ValueError:
                pass
    return rows


def label(r):
    p4, pi = r["p4"], r["pi"]
    if pi >= 0.99:
        return "100% Pi"
    if p4 == 0 and pi == 0:
        return "100% C6"
    parts = []
    if p4:
        parts.append(f"{p4:.0%} P4")
    if pi:
        parts.append(f"{pi:.0%} Pi")
    return " + ".join(parts)


def fin(x):
    return x if isinstance(x, float) and not math.isnan(x) else float("nan")


def main():
    src, out = sys.argv[1], sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else ""
    os.makedirs(out, exist_ok=True)
    rows = load(src)

    def save(fig, name):
        fig.tight_layout()
        fig.savefig(os.path.join(out, prefix + name), dpi=110)
        plt.close(fig)

    # 1. Mix (16 nodes): control p99 latency and blob time vs heterogeneity, aware vs baseline.
    mix = [r for r in rows if r["sweep"] == "mix"]
    labels = []
    for r in mix:
        if label(r) not in labels:
            labels.append(label(r))
    fig, ax = plt.subplots(1, 3, figsize=(13, 3.8))
    for aware, style in ((1.0, "o-"), (0.0, "x--")):
        name = "capacity-aware" if aware else "uniform small queues"
        for k, (traffic, metric, title) in enumerate(
            (
                ("control60", "lat_p99_ms", "control 60 Hz: p99 latency (ms)"),
                ("blob", "bulk_s", "4 KiB blob: time to all (s)"),
                ("mixed", "lat_p99_ms", "control 30 Hz during a blob: p99 (ms)"),
            )
        ):
            ys = []
            for lab in labels:
                v = [
                    fin(r[metric])
                    for r in mix
                    if label(r) == lab
                    and r["traffic"] == traffic
                    and r["aware"] == ("true" if aware else "false")
                ]
                ys.append(v[0] if v else float("nan"))
            ax[k].plot(range(len(labels)), ys, style, label=name)
            ax[k].set_title(title, fontsize=9)
            ax[k].set_xticks(range(len(labels)))
            ax[k].set_xticklabels(labels, rotation=40, ha="right", fontsize=7)
    ax[0].legend(fontsize=7)
    save(fig, "mix.png")

    # 2. Node count: delivery and blob time.
    nodes = [r for r in rows if r["sweep"] == "nodes"]
    fig, ax = plt.subplots(1, 3, figsize=(13, 3.8))
    for (p4, aware), style, name in (
        ((0.0, "true"), "s-", "100% C6"),
        ((0.5, "true"), "o-", "50% P4, aware"),
        ((0.5, "false"), "x--", "50% P4, baseline"),
    ):
        sel = [r for r in nodes if r["p4"] == p4 and r["aware"] == aware]
        for k, (traffic, metric, title) in enumerate(
            (
                ("control60", "delivery", "control 60 Hz: delivery ratio"),
                ("control60", "lat_p99_ms", "control 60 Hz: p99 latency (ms)"),
                ("blob", "bulk_s", "4 KiB blob: time to all (s)"),
            )
        ):
            pts = sorted((r["n"], fin(r[metric])) for r in sel if r["traffic"] == traffic)
            ax[k].plot([p[0] for p in pts], [p[1] for p in pts], style, label=name)
            ax[k].set_title(title, fontsize=9)
            ax[k].set_xlabel("nodes", fontsize=8)
    ax[0].legend(fontsize=7)
    save(fig, "nodes.png")

    # 3. Topology (32 nodes): blob time and control delivery.
    topo = [r for r in rows if r["sweep"] == "topology"]
    tops = ["Line", "Grid", "Random", "Clustered"]
    mixes = []
    for r in topo:
        if label(r) not in mixes:
            mixes.append(label(r))
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
    width = 0.8 / max(1, len(mixes))
    for j, lab in enumerate(mixes):
        for k, (traffic, metric, title) in enumerate(
            (
                ("blob", "bulk_frac", "4 KiB blob: fraction of nodes reached (60 s)"),
                ("control30", "delivery", "control 30 Hz: delivery ratio"),
            )
        ):
            ys = []
            for t in tops:
                v = [
                    fin(r[metric])
                    for r in topo
                    if r["topology"] == t and label(r) == lab and r["traffic"] == traffic
                ]
                ys.append(v[0] if v else float("nan"))
            ax[k].bar([i + j * width for i in range(len(tops))], ys, width, label=lab)
            ax[k].set_xticks([i + 0.4 - width / 2 for i in range(len(tops))])
            ax[k].set_xticklabels(tops, fontsize=8)
            ax[k].set_title(title, fontsize=9)
            ax[k].set_ylim(0, 1.05)
    ax[0].legend(fontsize=7)
    save(fig, "topology.png")

    # 4. Loss.
    loss = [r for r in rows if r["sweep"] == "loss"]
    fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
    for aware, style, name in (
        ("true", "o-", "capacity-aware"),
        ("false", "x--", "uniform small queues"),
    ):
        for k, (traffic, title) in enumerate(
            (("control60", "control 60 Hz"), ("mixed", "control 30 Hz during a blob"))
        ):
            pts = sorted(
                (r["loss"], fin(r["delivery"]))
                for r in loss
                if r["aware"] == aware and r["traffic"] == traffic
            )
            ax[k].plot([p[0] for p in pts], [p[1] for p in pts], style, label=name)
            ax[k].set_title(title + ": delivery vs loss", fontsize=9)
            ax[k].set_xlabel("per-reception loss", fontsize=8)
    ax[0].legend(fontsize=7)
    save(fig, "loss.png")

    # 5. Queues: peak relay occupancy per class vs budget, drops per class.
    fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
    sel = [r for r in rows if r["sweep"] in ("mix", "nodes") and r["aware"] == "true"]
    for cls, col in (("c6", "tab:blue"), ("p4", "tab:orange"), ("pi", "tab:green")):
        xs = [r["n"] + (0.3 if cls == "p4" else 0.6 if cls == "pi" else 0) for r in sel]
        ax[0].scatter(
            xs, [r[f"peak_relays_{cls}"] for r in sel], s=12, color=col, label=cls.upper()
        )
    ax[0].axhline(
        sel[0]["relay_budget"] if sel else 4, color="k", ls=":", label="C6-side relay budget"
    )
    ax[0].set_title("peak relay slots in use (C6 side) by class", fontsize=9)
    ax[0].set_xlabel("nodes", fontsize=8)
    ax[0].legend(fontsize=7)
    traffic_order = ["control60", "blob", "mixed", "firmware", "catchup"]
    for k, (col, key, name) in enumerate(
        (
            ("tab:blue", "drops_c6_bulk", "C6 bulk drops"),
            ("tab:red", "drops_c6_high", "C6 control/time/membership drops"),
            ("tab:orange", "drops_p4_bulk", "P4 bulk drops"),
        )
    ):
        ys = []
        for t in traffic_order:
            v = [
                r[key]
                for r in rows
                if r["sweep"] == "mix" and r["traffic"] == t and r["aware"] == "true"
            ]
            ys.append(sum(v))
        ax[1].bar(
            [i + k * 0.27 for i in range(len(traffic_order))], ys, 0.27, color=col, label=name
        )
    ax[1].set_xticks([i + 0.27 for i in range(len(traffic_order))])
    ax[1].set_xticklabels(traffic_order, fontsize=8)
    ax[1].set_title("relay drops by class and priority (16 nodes, all mixes)", fontsize=9)
    ax[1].legend(fontsize=7)
    save(fig, "queues.png")

    # Summary table.
    cols = [
        "sweep",
        "n",
        "topology",
        "p4",
        "pi",
        "loss",
        "traffic",
        "aware",
        "delivery",
        "lat_p50_ms",
        "lat_p99_ms",
        "bulk_s",
        "bulk_frac",
        "drops_c6_bulk",
        "drops_c6_high",
        "peak_relays_c6",
        "store_peak_p4",
        "store_peak_pi",
        "airtime",
    ]
    with open(os.path.join(out, prefix + "summary.md"), "w") as f:
        f.write("| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n")
        for r in rows:
            vals = []
            for c in cols:
                v = r[c]
                if isinstance(v, float):
                    v = "" if math.isnan(v) else (f"{v:.3g}" if abs(v) < 1000 else f"{v:.0f}")
                vals.append(str(v))
            f.write("| " + " | ".join(vals) + " |\n")


if __name__ == "__main__":
    main()
