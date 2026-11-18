#!/usr/bin/env python3
"""analyze — turn field-kit logs into link matrices, charts and a markdown report.

  analyze.py LOGS... [--roster roster.csv] [--dist dist.csv] --out DIR

LOGS: collector logs (*.log from `fieldkit.py collect`) and node flash dumps (*.bin from
`fieldkit.py pull`), any mix; the same window seen in several places is counted once (flash
copy preferred). Optional:
  roster.csv  id,label            names for node ids (e.g. 3,radiolarian-B)
  dist.csv    phase,a,b,metres    tape-measured distances per arrangement (for RSSI vs distance)
Writes DIR/REPORT.md, DIR/links.csv and DIR/*.png.
"""
from __future__ import annotations

import argparse
import collections
import csv
import math
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fieldwire as fw  # noqa: E402
import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

# Reference palette (dataviz skill, light mode): categorical in fixed order, one-hue sequential.
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
SEQ = LinearSegmentedColormap.from_list("seq_blue", ["#eef4fc", "#9cc3f0", "#2a78d6", "#0d3a73"])
RATE_ORDER = ["1", "2", "5.5", "11", "6", "9", "12", "18", "24", "36", "48", "54"]

plt.rcParams.update(
    {
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "axes.edgecolor": GRID,
        "axes.labelcolor": INK2,
        "xtick.color": INK2,
        "ytick.color": INK2,
        "text.color": INK,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.6,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.titleweight": "bold",
        "legend.frameon": False,
        "lines.linewidth": 2,
    }
)


def rate_key(r: str) -> int:
    return RATE_ORDER.index(r) if r in RATE_ORDER else 99


def rate_color(rates: list[str], r: str) -> str:
    return SERIES[sorted(set(rates), key=rate_key).index(r) % len(SERIES)]


class Link:
    """One directed link (tx -> rx) at one rate in one phase."""

    def __init__(self):
        self.rx = self.exp = self.urx = self.uexp = self.dup = 0
        self.aok = self.afail = 0
        self.sent = 0
        self.rssi_w = []  # (mean, weight) per window
        self.rmin = None
        self.windows = self.outage = 0
        self.ptx = set()

    def delivery(self) -> float | None:
        den = self.sent if self.sent else self.exp
        return None if den == 0 else min(1.0, self.rx / den)

    def ack(self) -> float | None:
        n = self.aok + self.afail
        return None if n == 0 else self.aok / n

    def udeliv(self) -> float | None:
        return None if self.uexp == 0 else min(1.0, self.urx / self.uexp)

    def rssi_mean(self) -> float | None:
        w = sum(x[1] for x in self.rssi_w)
        return None if w == 0 else sum(m * n for m, n in self.rssi_w) / w

    def rssi_p10(self) -> float | None:
        vals = sorted(m for m, n in self.rssi_w if n)
        return (
            None if not vals else vals[max(0, int(0.1 * len(vals)) - (1 if len(vals) >= 10 else 0))]
        )


def build(ds: fw.Dataset):
    links = collections.defaultdict(Link)  # (phase, tx, rx, rate)
    series = collections.defaultdict(list)  # (tx, rx, rate) -> [(t, phase, rssi, deliv)]
    for (node, boot, win), w in sorted(ds.windows.items()):
        off = ds.wall_offset(node, boot)
        t = w.up_ms / 1000.0 + off if off is not None else None
        for e in w.entries:
            if e.flags & fw.F_SELF or e.peer == node:
                links[(w.phase, node, "*", e.rate)].sent += e.rx
                continue
            L = links[(w.phase, e.peer, node, e.rate)]
            L.rx += e.rx
            L.exp += e.exp
            L.urx += e.urx
            L.uexp += e.uexp
            L.dup += e.dup
            L.windows += 1
            n = e.rx + e.urx
            if n:
                L.rssi_w.append((e.rmean, n))
                L.rmin = e.rmin if L.rmin is None else min(L.rmin, e.rmin)
            if e.flags & fw.F_OUTAGE:
                L.outage += 1
            L.ptx.add(e.ptx)
            # my unicasts to e.peer: the reverse direction's ACK
            A = links[(w.phase, node, e.peer, e.rate)]
            A.aok += e.aok
            A.afail += e.afail
            d = (e.rx / e.exp) if e.exp else (0.0 if e.flags & fw.F_OUTAGE else None)
            series[(e.peer, node, e.rate)].append(
                (
                    t,
                    w.up_ms / 1000.0,
                    w.phase,
                    e.rmean if n else None,
                    min(1.0, d) if d is not None else None,
                )
            )
    # sender-based denominators
    for (phase, tx, rx, rate), L in list(links.items()):
        if rx == "*":
            continue
        S = links.get((phase, tx, "*", rate))
        if S and S.sent:
            L.sent = S.sent
    return links, series


def fmt(v, pct=False, nd=0):
    if v is None:
        return "–"
    return f"{100 * v:.{nd}f} %" if pct else f"{v:.{nd}f}"


def node_label(roster, n):
    return roster.get(n, str(n))


def matrix_chart(links, phase, label, nodes, rates, roster, path):
    metrics = [
        ("Broadcast delivery", lambda L: L.delivery(), True),
        ("Unicast ACK", lambda L: L.ack(), True),
    ]
    fig, axes = plt.subplots(
        len(metrics) + 1,
        len(rates),
        figsize=(2.6 * len(rates) + 0.6, 2.4 * (len(metrics) + 1)),
        squeeze=False,
    )
    names = [node_label(roster, n) for n in nodes]
    for ci, rate in enumerate(rates):
        for ri, (title, fn, pct) in enumerate(
            metrics + [("Mean RSSI (dBm)", lambda L: L.rssi_mean(), False)]
        ):
            ax = axes[ri][ci]
            ax.grid(False)
            m = [[None] * len(nodes) for _ in nodes]
            for i, tx in enumerate(nodes):
                for j, rx in enumerate(nodes):
                    L = links.get((phase, tx, rx, rate))
                    if L is not None and tx != rx:
                        m[i][j] = fn(L)
            vals = [[(v if v is not None else float("nan")) for v in row] for row in m]
            if pct:
                ax.imshow(vals, cmap=SEQ, vmin=0.5, vmax=1.0)
            else:
                ax.imshow(vals, cmap=SEQ, vmin=-95, vmax=-20)
            for i in range(len(nodes)):
                for j in range(len(nodes)):
                    v = m[i][j]
                    if v is None:
                        ax.text(j, i, "·" if i != j else "", ha="center", va="center", color=INK2)
                        continue
                    hi = (v > 0.8) if pct else (v > -45)
                    ax.text(
                        j,
                        i,
                        f"{100 * v:.0f}" if pct else f"{v:.0f}",
                        ha="center",
                        va="center",
                        fontsize=8,
                        color="#ffffff" if hi else INK,
                    )
            ax.set_xticks(range(len(nodes)), names, fontsize=7)
            ax.set_yticks(range(len(nodes)), names, fontsize=7)
            if ri == 0:
                ax.set_title(f"{rate} Mb/s\n{title}" if ci == 0 or True else title)
            else:
                ax.set_title(title, fontweight="normal")
            if ci == 0:
                ax.set_ylabel("from (TX)")
            ax.set_xlabel("to (RX)")
    fig.suptitle(
        f"Phase {phase}{' — ' + label if label else ''}: link matrix (%, dBm)",
        x=0.02,
        ha="left",
        fontweight="bold",
    )
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def delivery_vs_rssi(series, rates, path):
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    for rate in rates:
        bins = collections.defaultdict(list)
        for (tx, rx, r), pts in series.items():
            if r != rate:
                continue
            for _, _, _, rssi, d in pts:
                if rssi is not None and d is not None:
                    bins[int(math.floor(rssi / 3.0) * 3)].append(d)
        xs = sorted(b for b in bins if len(bins[b]) >= 3)
        if not xs:
            continue
        ys = [100 * statistics.mean(bins[b]) for b in xs]
        ax.plot(
            [x + 1.5 for x in xs],
            ys,
            color=rate_color(rates, rate),
            marker="o",
            markersize=4,
            label=f"{rate} Mb/s",
        )
    ax.set_xlabel("window mean RSSI (dBm, 3 dB bins)")
    ax.set_ylabel("broadcast delivery (%)")
    ax.set_ylim(0, 102)
    ax.set_title("Delivery vs RSSI, per rate (every link, every window)", loc="left")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def rssi_vs_distance(links, dists, rates, path):
    pts = []
    for (phase, a, b), m in dists.items():
        for tx, rx in ((a, b), (b, a)):
            rate = rates[0]
            L = links.get((phase, tx, rx, rate))
            if L and L.rssi_mean() is not None:
                pts.append((m, L.rssi_mean(), L.rmin))
    if not pts:
        return False
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    ax.scatter(
        [p[0] for p in pts],
        [p[1] for p in pts],
        s=40,
        color=SERIES[0],
        edgecolor=SURFACE,
        linewidth=1.5,
        label="mean",
        zorder=3,
    )
    ax.scatter(
        [p[0] for p in pts],
        [p[2] for p in pts],
        s=24,
        color=SERIES[1],
        edgecolor=SURFACE,
        linewidth=1.5,
        label="minimum",
        zorder=3,
    )
    # Free-space slope (20 dB/decade) through the median 1-m-normalised point.
    k = statistics.median(p[1] + 20 * math.log10(p[0]) for p in pts)
    xs = [min(p[0] for p in pts) * 0.8, max(p[0] for p in pts) * 1.2]
    ax.plot(
        xs,
        [k - 20 * math.log10(x) for x in xs],
        color=INK2,
        linewidth=1,
        linestyle="--",
        label=f"free space (20 dB/dec), {k:.0f} dBm @ 1 m",
    )
    ax.set_xscale("log")
    ax.set_xlabel("distance (m, tape)")
    ax.set_ylabel("RSSI (dBm)")
    ax.set_title(f"RSSI vs distance ({rates[0]} Mb/s frames, both directions)", loc="left")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return True


def timeseries(series, phases, rate, labels, roster, path, max_links=8):
    keys = [k for k in series if k[2] == rate and any(p[2] in phases for p in series[k])]
    if not keys:
        return False

    def spread(k):
        v = [p[3] for p in series[k] if p[2] in phases and p[3] is not None]
        return statistics.pstdev(v) if len(v) > 1 else 0

    keys = sorted(keys, key=spread, reverse=True)[:max_links]
    keys = sorted(keys)
    fig, axes = plt.subplots(2, 1, figsize=(8.5, 5.2), sharex=True)
    t0 = None
    for i, k in enumerate(keys):
        pts = [p for p in series[k] if p[2] in phases]
        use_wall = all(p[0] is not None for p in pts)
        xs = [p[0] if use_wall else p[1] for p in pts]
        if t0 is None:
            t0 = min(xs)
        xs = [(x - t0) / 60.0 for x in xs]
        name = f"{node_label(roster, k[0])}→{node_label(roster, k[1])}"
        c = SERIES[i % len(SERIES)]
        axes[0].plot(
            xs,
            [p[3] if p[3] is not None else float("nan") for p in pts],
            color=c,
            linewidth=1.4,
            label=name,
        )
        axes[1].plot(
            xs,
            [100 * p[4] if p[4] is not None else float("nan") for p in pts],
            color=c,
            linewidth=1.4,
        )
    # phase boundaries: the first window of each phase on the first link
    if keys:
        pts = sorted((p for p in series[keys[0]] if p[2] in phases), key=lambda p: p[1])
        seen = set()
        for p in pts:
            if p[2] in seen:
                continue
            seen.add(p[2])
            x = ((p[0] if all(q[0] is not None for q in pts) else p[1]) - t0) / 60.0
            for ax in axes:
                ax.axvline(x, color=INK2, linewidth=0.8, linestyle=":")
            axes[1].text(
                x,
                2,
                f" {p[2]} {labels.get(p[2], '')}",
                fontsize=7,
                color=INK2,
                rotation=90,
                va="bottom",
            )
    axes[0].set_ylabel("RSSI (dBm, 2 s windows)")
    axes[1].set_ylabel(f"delivery @ {rate} Mb/s (%)")
    axes[1].set_ylim(-3, 103)
    axes[1].set_xlabel("minutes")
    names = ", ".join(f"{p}{' ' + labels[p] if p in labels else ''}" for p in sorted(phases))
    axes[0].set_title(f"Links over time — phase {names}", loc="left")
    axes[0].legend(fontsize=7, loc="upper left", bbox_to_anchor=(1.01, 1.0))
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return True


def mesh_tables(ds):
    """(phase, origin, receiver) -> [rx, exp, hsum, hmin, hmax]."""
    agg = collections.defaultdict(lambda: [0, 0, 0, 99, 0])
    for (node, boot, win), w in sorted(ds.mesh.items()):
        for e in w.entries:
            if e.origin == node:
                continue
            a = agg[(w.phase, e.origin, node)]
            a[0] += e.rx
            a[1] += e.exp
            a[2] += e.hsum
            if e.rx:
                a[3] = min(a[3], e.hmin)
                a[4] = max(a[4], e.hmax)
    return agg


def mesh_chart(agg, rtts, phase, label, nodes, roster, path):
    fig, axes = plt.subplots(1, 3, figsize=(11.5, 3.6))
    names = [node_label(roster, n) for n in nodes]
    for ax, title, fn, vmin, vmax in (
        (axes[0], "Flood delivery (%)", lambda a: a[0] / a[1] if a[1] else None, 0.5, 1.0),
        (axes[1], "Mean relays (0 = direct)", lambda a: a[2] / a[0] if a[0] else None, 0, 3),
    ):
        ax.grid(False)
        m = [[None] * len(nodes) for _ in nodes]
        for i, o in enumerate(nodes):
            for j, r in enumerate(nodes):
                a = agg.get((phase, o, r))
                if a and o != r:
                    m[i][j] = fn(a)
        ax.imshow(
            [[v if v is not None else float("nan") for v in row] for row in m],
            cmap=SEQ,
            vmin=vmin,
            vmax=vmax,
        )
        for i in range(len(nodes)):
            for j in range(len(nodes)):
                v = m[i][j]
                if v is None:
                    continue
                pct = vmax == 1.0
                hi = v > (0.8 if pct else 1.8)
                ax.text(
                    j,
                    i,
                    f"{100 * v:.0f}" if pct else f"{v:.1f}",
                    ha="center",
                    va="center",
                    fontsize=8,
                    color="#ffffff" if hi else INK,
                )
        ax.set_xticks(range(len(nodes)), names, fontsize=7)
        ax.set_yticks(range(len(nodes)), names, fontsize=7)
        ax.set_xlabel("receiver")
        ax.set_ylabel("origin")
        ax.set_title(title, loc="left")
    ax = axes[2]
    rs = [r for r in rtts if r[0] == phase]
    by = collections.defaultdict(list)
    for _, r in rs:
        by[r.node].append(r.rtt_ms)
    ks = sorted(by)
    if ks:
        for i, k in enumerate(ks):
            v = sorted(by[k])
            ax.scatter([i] * len(v), v, s=10, color=SERIES[0], alpha=0.35, edgecolor="none")
            ax.plot([i - 0.3, i + 0.3], [statistics.median(v)] * 2, color=INK, linewidth=2)
        ax.set_xticks(range(len(ks)), [node_label(roster, k) for k in ks], fontsize=7)
        ax.set_ylabel("ping round trip (ms)")
        ax.set_title("Collector ping RTT per node (bar = median)", loc="left")
    else:
        ax.set_axis_off()
    fig.suptitle(
        f"Phase {phase}{' — ' + label if label else ''}: mesh flood (real splanc_mesh::Node)",
        x=0.02,
        ha="left",
        fontweight="bold",
    )
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--roster")
    ap.add_argument("--dist")
    ap.add_argument("--out", required=True)
    ap.add_argument("--prefix", default="", help="filename prefix for the charts")
    ap.add_argument("--walk", default="walk", help="label substring of the people-walking phases")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ds = fw.Dataset()
    for p in a.logs:
        (ds.load_flash if p.endswith(".bin") else ds.load_log)(p)
    roster = {}
    if a.roster:
        for row in csv.reader(open(a.roster)):
            if row and row[0].strip().isdigit():
                roster[int(row[0])] = row[1].strip()
    dists = {}
    if a.dist:
        for row in csv.reader(open(a.dist)):
            if row and row[0].strip().isdigit():
                ph, x, y, m = int(row[0]), int(row[1]), int(row[2]), float(row[3])
                dists[(ph, x, y)] = m
    links, series = build(ds)
    labels = ds.phase_labels()
    labels.setdefault(0, "setup (before the first phase marker)")
    nodes = sorted({k[1] for k in links if k[2] != "*"} | {k[2] for k in links if k[2] != "*"})
    rates = sorted({k[3] for k in links}, key=rate_key)
    phases = sorted({k[0] for k in links})
    P = a.prefix
    charts = []
    for ph in phases:
        if not any(k[0] == ph and k[2] != "*" and links[k].windows for k in links):
            continue
        f = f"{P}matrix-phase{ph}.png"
        matrix_chart(links, ph, labels.get(ph, ""), nodes, rates, roster, os.path.join(a.out, f))
        charts.append(
            (
                f,
                f"Phase {ph} {labels.get(ph, '')}: all-pairs broadcast delivery, unicast ACK and mean RSSI "
                f"per rate (rows = sender, columns = receiver).",
            )
        )
    magg = mesh_tables(ds)
    # RTTs: phase by the collector's phase at that host time (nearest earlier phase record)
    starts = sorted((p.host_unix, p.phase) for p in ds.phases if p.host_unix)
    rtts = []
    for r in ds.rtts:
        ph = 0
        for t, p in starts:
            if t <= r.host_t:
                ph = p
        rtts.append((ph, r))
    mphases = sorted({k[0] for k in magg} | {p for p, _ in rtts})
    for ph in mphases:
        f = f"{P}mesh-phase{ph}.png"
        mn = (
            sorted({k[1] for k in magg if k[0] == ph} | {k[2] for k in magg if k[0] == ph}) or nodes
        )
        mesh_chart(magg, rtts, ph, labels.get(ph, ""), mn, roster, os.path.join(a.out, f))
        charts.append(
            (
                f,
                f"Phase {ph} {labels.get(ph, '')}: real-mesh flood delivery and relay count (0 = direct) per "
                "origin/receiver, and ping round trips from the collector.",
            )
        )
    f = f"{P}delivery-vs-rssi.png"
    delivery_vs_rssi(series, rates, os.path.join(a.out, f))
    charts.append(
        (f, "Broadcast delivery vs window-mean RSSI for each rate: where each rate falls off.")
    )
    if dists:
        f = f"{P}rssi-vs-distance.png"
        if rssi_vs_distance(links, dists, rates, os.path.join(a.out, f)):
            charts.append(
                (f, "Mean and minimum RSSI vs tape-measured distance, with a free-space reference.")
            )
    walk = [p for p, lab in labels.items() if a.walk in lab.lower()]
    for group, tag in ((walk, "walking"), (phases, "all")):
        if not group:
            continue
        f = f"{P}timeseries-{tag}.png"
        if timeseries(series, set(group), rates[0], labels, roster, os.path.join(a.out, f)):
            charts.append(
                (
                    f,
                    f"RSSI and delivery per 2 s window over time ({tag} phases, {rates[0]} Mb/s; the "
                    "links that varied most).",
                )
            )

    with open(os.path.join(a.out, f"{P}links.csv"), "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(
            [
                "phase",
                "label",
                "tx",
                "rx",
                "rate",
                "bcast_rx",
                "bcast_den",
                "delivery",
                "uni_rx",
                "uni_exp",
                "uni_delivery",
                "ack_ok",
                "ack_fail",
                "ack",
                "rssi_mean",
                "rssi_p10_window",
                "rssi_min",
                "windows",
                "outage_windows",
                "dup",
            ]
        )
        for (ph, tx, rx, rate), L in sorted(
            links.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]), rate_key(kv[0][3]))
        ):
            if rx == "*":
                continue
            wr.writerow(
                [
                    ph,
                    labels.get(ph, ""),
                    tx,
                    rx,
                    rate,
                    L.rx,
                    L.sent or L.exp,
                    fmt(L.delivery(), nd=3),
                    L.urx,
                    L.uexp,
                    fmt(L.udeliv(), nd=3),
                    L.aok,
                    L.afail,
                    fmt(L.ack(), nd=3),
                    fmt(L.rssi_mean(), nd=1),
                    fmt(L.rssi_p10()),
                    fmt(L.rmin),
                    L.windows,
                    L.outage,
                    L.dup,
                ]
            )

    srcs = collections.Counter(w.source for w in ds.windows.values())
    lines = [
        "# Mesh field test — link report",
        "",
        f"Inputs: {len(a.logs)} files; {len(ds.windows)} windows ({dict(srcs)}); {len(ds.frames)} raw frames "
        f"at the collector(s) {sorted(ds.collector_nodes)}; nodes {nodes}; rates {rates} Mb/s.",
        "",
    ]
    for ph in phases:
        rows = [(k, L) for k, L in links.items() if k[0] == ph and k[2] != "*" and L.windows]
        if not rows:
            continue
        lines += [
            f"## Phase {ph}{' — ' + labels[ph] if ph in labels else ''}",
            "",
            "| link | rate | bcast delivery | unicast ACK | unicast delivered | RSSI mean | p10 | min "
            "| outage windows |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for (p, tx, rx, rate), L in sorted(
            rows, key=lambda kv: (kv[0][1], kv[0][2], rate_key(kv[0][3]))
        ):
            lines.append(
                f"| {node_label(roster, tx)}→{node_label(roster, rx)} | {rate} | {fmt(L.delivery(), True, 1)} "
                f"({L.rx}/{L.sent or L.exp}) | {fmt(L.ack(), True, 1)} ({L.aok}/{L.aok + L.afail}) | "
                f"{fmt(L.udeliv(), True, 1)} | {fmt(L.rssi_mean(), nd=1)} | {fmt(L.rssi_p10())} | "
                f"{fmt(L.rmin)} | {L.outage}/{L.windows} |"
            )
        # per-rate roll-up
        for rate in rates:
            rr = [L for (k, L) in rows if k[3] == rate]
            if not rr:
                continue
            rx = sum(L.rx for L in rr)
            den = sum(L.sent or L.exp for L in rr)
            ok = sum(L.aok for L in rr)
            n = sum(L.aok + L.afail for L in rr)
            worst = min((L.delivery() for L in rr if L.delivery() is not None), default=None)
            lines.append(
                f"\n**{rate} Mb/s, all links:** broadcast {fmt(rx / den if den else None, True, 1)}, worst link "
                f"{fmt(worst, True, 1)}; unicast ACK {fmt(ok / n if n else None, True, 1)}."
            )
        lines.append("")
    for ph in mphases:
        rows = [(k, v) for k, v in magg.items() if k[0] == ph]
        if not rows and not any(p == ph for p, _ in rtts):
            continue
        lines += [
            f"## Mesh flood, phase {ph}{' — ' + labels[ph] if ph in labels else ''}",
            "",
            "| origin→receiver | delivered | mean relays | relays min..max |",
            "| --- | --- | --- | --- |",
        ]
        for (p, o, r), v in sorted(rows):
            lines.append(
                f"| {node_label(roster, o)}→{node_label(roster, r)} | "
                f"{fmt(v[0] / v[1] if v[1] else None, True, 1)} ({v[0]}/{v[1]}) | "
                f"{fmt(v[2] / v[0] if v[0] else None, nd=2)} | {v[3] if v[0] else '–'}..{v[4]} |"
            )
        rr = [r for p, r in rtts if p == ph]
        if rr:
            by = collections.defaultdict(list)
            for r in rr:
                by[r.node].append(r)
            lines += [
                "",
                "| ping to | replies | RTT p50 | p90 | max | relays out/back |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
            for n, v in sorted(by.items()):
                ts = sorted(x.rtt_ms for x in v)
                lines.append(
                    f"| {node_label(roster, n)} | {len(v)} | {ts[len(ts) // 2]} ms | "
                    f"{ts[min(len(ts) - 1, int(0.9 * len(ts)))]} ms | {ts[-1]} ms | "
                    f"{statistics.mean(x.hops_out for x in v):.1f}/{statistics.mean(x.hops_back for x in v):.1f} |"
                )
        lines.append("")
    lines += ["## Charts", ""] + [f"- `{f}` — {c}" for f, c in charts]
    lines += [
        "",
        "Delivery = broadcasts received / sent by the sender in that phase (or / the sequence span when "
        "the sender's own log is missing). ACK = the sender's MAC saw the receiver's hardware ACK (after "
        "retries). RSSI p10 = 10th percentile of 2-s window means; min = the lowest single frame.",
    ]
    open(os.path.join(a.out, f"{P}REPORT.md"), "w").write("\n".join(lines) + "\n")
    print(f"wrote {a.out}/{P}REPORT.md, {len(charts)} charts")
    for f, c in charts:
        print(f"  {f}: {c}")


if __name__ == "__main__":
    main()
