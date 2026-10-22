#!/usr/bin/env python3
"""Tables + charts for docs/design/fx-perf-study.md from the bench runs.

  python3 tools/fx_perf/report.py --runs <dir with v1.json pr328.json p1.json ...> \
      --est <dir with main.json pr328.json> --user-index <index.json> \
      --agent <tools/fx_agent_eval/out/analysis.json> --img docs/design/img/fx-perf --md out.md

Needs matplotlib (a local venv is fine). Every number printed into the doc
comes from here, so a rerun on new bench logs regenerates the study's tables.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics as st

CPU = 160e6
STUDY = [
    "solid",
    "sweep",
    "gradient",
    "texture",
    "rain",
    "pulses",
    "sparkle",
    "flood",
    "cylinder",
    "plasma",
    "noise",
    "particles",
    "rain_naive",
]
# validated categorical slots (dataviz reference palette, light surface)
C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
INK = "#0b0b0b"
INK2 = "#52514e"
SURF = "#fcfcfb"


def load(p):
    return json.load(open(p)) if os.path.exists(p) else None


def by(d, kind="vm"):
    return {(r["name"], r["fixture"], r["n"]): r for r in d[kind]} if d else {}


def nat(d):
    out = {}
    for r in d["native"]:
        out[(r["name"], r["variant"], r["n"])] = r
    return out


def style(plt):
    plt.rcParams.update(
        {
            "figure.facecolor": SURF,
            "axes.facecolor": SURF,
            "savefig.facecolor": SURF,
            "axes.edgecolor": INK2,
            "axes.labelcolor": INK,
            "xtick.color": INK2,
            "ytick.color": INK2,
            "text.color": INK,
            "font.size": 9,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.color": "#e4e3df",
            "grid.linewidth": 0.6,
            "axes.axisbelow": True,
        }
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True)
    ap.add_argument("--est", required=True)
    ap.add_argument("--user-index")
    ap.add_argument("--agent")
    ap.add_argument("--img", required=True)
    ap.add_argument("--md", required=True)
    a = ap.parse_args()
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    style(plt)
    os.makedirs(a.img, exist_ok=True)
    R = {
        k: load(os.path.join(a.runs, k + ".json"))
        for k in ["v1", "v2", "pr328", "p1", "p2", "p3", "agentfix"]
    }
    v1 = R["v1"]
    VM, JIT, N = by(v1), by(v1, "jit"), nat(v1)
    md = []

    # ---- Q1 table -----------------------------------------------------------
    md.append(
        "| effect | VM cyc/LED | JIT cyc/LED | native f32 | native q16 | VM ÷ f32 | VM ÷ q16 | "
        "VM ms @500 | VM ms @2048 | q16 ms @2048 |"
    )
    md.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    q1 = []
    for e in STUDY:
        v5, v2k = VM[(e, "helix", 500)], VM[(e, "helix", 2048)]
        j5 = JIT[(e, "helix", 500)]
        f = N.get((e, "f32", 500))
        q = N.get((e, "q16", 500))
        q2k = N.get((e, "q16", 2048)) or N.get((e, "f32", 2048))
        vl = v5["frame"] / 500
        fl = f["frame"] / 500 if f else None
        ql = q["frame"] / 500 if q else None
        q1.append((e, vl, j5["frame"] / 500, fl, ql, v5))
        md.append(
            f"| {e} | {vl:,.0f} | {j5['frame']/500:,.0f}{'' if j5['blocks'] else ' (no JIT)'} | "
            f"{(f'{fl:,.0f}' if fl else '—')} | {(f'{ql:,.0f}' if ql else '—')} | "
            f"{(f'{vl/fl:.1f}×' if fl else '—')} | {(f'{vl/ql:.0f}×' if ql else '—')} | "
            f"{v5['frame']/CPU*1e3:.1f} | {v2k['frame']/CPU*1e3:.1f} | {(q2k['frame']/CPU*1e3 if q2k else 0):.1f} |"
        )
    md.append("")

    fig, ax = plt.subplots(figsize=(7.6, 3.4))
    xs = range(len(q1))
    w = 0.2
    series = [
        ("VM", 1, C[0]),
        ("VM + JIT", 2, C[1]),
        ("native f32 (same math)", 3, C[2]),
        ("native q16 (rewrite)", 4, C[3]),
    ]
    for k, (lab, idx, col) in enumerate(series):
        vals = [r[idx] if r[idx] else 0 for r in q1]
        ax.bar([x + (k - 1.5) * w for x in xs], vals, w - 0.02, label=lab, color=col)
    ax.set_yscale("log")
    ax.set_xticks(list(xs))
    ax.set_xticklabels([r[0] for r in q1], rotation=35, ha="right")
    ax.set_ylabel("C6 cycles per LED per frame (log)")
    ax.set_title(
        "Same effect, four ways — measured on the ESP32-C6 (500-LED helix)", loc="left", fontsize=10
    )
    ax.axhline(5.3e6 / 500, color=INK2, lw=0.8, ls="--")
    ax.text(
        -0.45,
        5.3e6 / 500 * 1.15,
        "30 fps budget @ 500 LEDs (5.3 M cycles/frame)",
        ha="left",
        fontsize=7.5,
        color=INK2,
    )
    ax.legend(frameon=False, fontsize=8, ncol=4, loc="upper left", bbox_to_anchor=(0, -0.32))
    fig.tight_layout()
    fig.savefig(os.path.join(a.img, "q1-vm-jit-native.png"), dpi=150)
    plt.close(fig)

    # ---- Q1 decomposition -----------------------------------------------------
    run_empty = v1["micro_vm"]["run_empty"]
    md.append(
        "| effect | framing (Led fill) | VM invocation fixed | "
        "interpretation (dispatch + stack + decode) | soft-float + float transcendentals | "
        "fixed-point compute (q16 native) |"
    )
    md.append("|---|---:|---:|---:|---:|---:|")
    dec = []
    for e, vl, jl, fl, ql, v5 in q1:
        fill = v5["fill"] / 500
        if fl is None:
            continue
        q = ql if ql else fl
        interp = max(0.0, vl - fill - run_empty - fl)
        soft = max(0.0, fl - q)
        dec.append((e, fill, run_empty, interp, soft, q))
        md.append(f"| {e} | {fill:,.0f} | {run_empty:,} | {interp:,.0f} | {soft:,.0f} | {q:,.0f} |")
    md.append("")
    fig, ax = plt.subplots(figsize=(7.6, 3.2))
    labs = [
        "per-LED framing",
        "VM invocation (fixed)",
        "interpretation",
        "soft-float / transcendentals",
        "irreducible (q16 native)",
    ]
    bottom = [0.0] * len(dec)
    for k in range(5):
        vals = [d[k + 1] for d in dec]
        ax.bar(
            [d[0] for d in dec],
            vals,
            0.7,
            bottom=bottom,
            label=labs[k],
            color=C[k],
            edgecolor=SURF,
            linewidth=1,
        )
        bottom = [b + v for b, v in zip(bottom, vals)]
    ax.set_ylabel("C6 cycles per LED")
    ax.set_title("Where the VM's cycles go (VM total = stack height)", loc="left", fontsize=10)
    plt.setp(ax.get_xticklabels(), rotation=35, ha="right")
    ax.legend(frameon=False, fontsize=8, ncol=3, loc="upper left", bbox_to_anchor=(0, -0.3))
    fig.tight_layout()
    fig.savefig(os.path.join(a.img, "q1-decomposition.png"), dpi=150)
    plt.close(fig)

    # ---- Q3 estimator ---------------------------------------------------------
    for v in ["main", "pr328", "agent_main", "agent_pr328"]:
        e = load(os.path.join(a.est, v + ".json"))
        if e:
            rs = sorted(x["ratio"] for x in e if "ratio" in x)
            md.append(
                f"estimator {v}: n={len(rs)} median={st.median(rs):.3f} p10={rs[len(rs)//10]:.3f} "
                f"p90={rs[9*len(rs)//10]:.3f} min={rs[0]:.3f} max={rs[-1]:.3f}"
            )
    fig, axs = plt.subplots(1, 2, figsize=(7.6, 3.4), sharey=True)
    for ax, v, col, title in [
        (axs[0], "main", C[7], "main (shipped default table)"),
        (axs[1], "pr328", C[0], "PR #328 (refit table + walker)"),
    ]:
        e = (load(os.path.join(a.est, v + ".json")) or []) + (
            load(os.path.join(a.est, "agent_" + v + ".json")) or []
        )
        groups = {
            "fx_bench calibration": [],
            "study effects": [],
            "user library": [],
            "agent-generated": [],
        }
        for x in e:
            if "ratio" not in x:
                continue
            g = (
                "fx_bench calibration"
                if x["fixture"] == "fx_bench"
                else (
                    "study effects"
                    if x["label"] in STUDY
                    else ("agent-generated" if "__" in x["label"] else "user library")
                )
            )
            if x["fixture"] == "linear":
                g = "fx_bench calibration"
            groups[g].append(x)
        for k, (g, xs_) in enumerate(groups.items()):
            ax.scatter(
                [x["measured"] / CPU * 1e3 for x in xs_],
                [x["frameCycles"] / CPU * 1e3 for x in xs_],
                s=14,
                color=C[k],
                label=g,
                alpha=0.85,
                edgecolors="none",
            )
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.plot([0.5, 400], [0.5, 400], color=INK2, lw=0.8, ls="--")
        ax.set_xlim(0.5, 400)
        ax.set_ylim(0.005, 400)
        ax.set_title(title, loc="left", fontsize=9)
        ax.set_xlabel("measured frame ms (C6)")
    axs[0].set_ylabel("estimated frame ms")
    axs[1].legend(frameon=False, fontsize=7, loc="lower right")
    fig.tight_layout()
    fig.savefig(os.path.join(a.img, "q3-estimator.png"), dpi=150)
    plt.close(fig)

    # ---- user library ---------------------------------------------------------
    if a.user_index:
        idx = json.load(open(a.user_index))
        md.append("")
        md.append(
            "| effect | written for | sign @500 ms | cylinder @250 ms | cyc/LED sign | cyc/LED cyl | "
            "ops/LED | old estimate ms (fixture) | measured ÷ estimate | #328 Δ sign |"
        )
        md.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        P = by(R["pr328"]) if R["pr328"] else {}
        rows = []
        for m in idx:
            s, c = VM.get((m["slug"], "sign", 500)), VM.get((m["slug"], "helix", 250))
            if not s or not c:
                continue
            # pair each stored estimate with the measurement on its own fixture
            if m["est"].get("FugWidget"):
                est, own = m["est"]["FugWidget"], s
            else:
                est, own = m["est"].get("PixieLamp"), c
            p = P.get((m["slug"], "sign", 500))
            if m["slug"].endswith("_2"):
                m = dict(m, name=m["name"] + " #2")
            rows.append((m, s, c, est, own, p))
        rows.sort(key=lambda r: -r[1]["frame"])
        for m, s, c, est, own, p in rows:
            md.append(
                f"| {m['name']} | {m['target'].replace('signcyl', 'both')} | {s['frame']/CPU*1e3:.1f} | "
                f"{c['frame']/CPU*1e3:.1f} | "
                f"{s['frame']/500:,.0f} | {c['frame']/250:,.0f} | {s['ops']/500:.0f} | "
                f"{(f'{est} ({chr(115) if own is s else chr(99)})' if est else '—')} | "
                f"{(f'{own['frame']/CPU*1e3/est:.0f}×' if est else '—')} | "
                f"{(f'{(p['frame']/s['frame']-1)*100:+.0f}%' if p else '—')} |"
            )
        fig, ax = plt.subplots(figsize=(7.6, 8.0))
        ys = list(range(len(rows)))
        ax.barh(
            [y + 0.2 for y in ys],
            [r[1]["frame"] / CPU * 1e3 for r in rows],
            0.4,
            color=C[0],
            label="sign, 500 LEDs",
        )
        ax.barh(
            [y - 0.2 for y in ys],
            [r[2]["frame"] / CPU * 1e3 for r in rows],
            0.4,
            color=C[1],
            label="cylinder, 250 LEDs",
        )
        ax.scatter(
            [r[3] or 0 for r in rows],
            ys,
            marker="|",
            s=40,
            color=INK,
            label="old offline estimate",
            zorder=3,
        )
        ax.axvline(33.3, color=INK2, lw=0.8, ls="--")
        ax.text(34, len(rows) - 1, "33 ms = 30 fps", fontsize=8, color=INK2, va="top")
        ax.set_yticks(ys)
        ax.set_yticklabels([r[0]["name"][:30] for r in rows], fontsize=7)
        ax.invert_yaxis()
        ax.set_xlabel("VM frame time on the C6 (ms, update + shade)")
        ax.set_title("The user's 45 library effects, measured", loc="left", fontsize=10)
        ax.legend(frameon=False, fontsize=7, loc="lower right")
        fig.tight_layout()
        fig.savefig(os.path.join(a.img, "q2-user-library.png"), dpi=150)
        plt.close(fig)

    # ---- agent-generated set (Q2) ----------------------------------------------
    if R["agentfix"]:
        FW = 600  # firmware per-LED framing the radio-less bench doesn't run
        AV = {
            r["name"]: r
            for r in R["agentfix"]["vm"]
            if r["fixture"] == "helix" and r["n"] == 500 and "__" in r["name"]
        }
        AJ = {
            r["name"]: r
            for r in R["agentfix"]["jit"]
            if r["fixture"] == "helix" and r["n"] == 500 and "__" in r["name"]
        }
        order = [
            ("skill", "sonnet"),
            ("skill", "opus"),
            ("app", "sonnet"),
            ("app", "opus"),
            ("app_lint", "opus"),
            ("app_perf", "opus"),
        ]
        md.append("")
        md.append(
            "| path / model | n | median ms @500 | p25–p75 ms | fits 33 ms (VM) | fits (VM+JIT) | mean cyc/LED |"
        )
        md.append("|---|---:|---:|---:|---:|---:|---:|")
        fig, ax = plt.subplots(figsize=(7.6, 3.0))
        for k, (var, mod) in enumerate(order):
            xs = [
                (n, (r["frame"] + FW * 500) / CPU * 1e3)
                for n, r in AV.items()
                if n.startswith(f"{var}__{mod}__")
            ]
            if not xs:
                continue
            ms = sorted(x[1] for x in xs)
            js = [(AJ[n]["frame"] + FW * 500) / CPU * 1e3 for n, _ in xs]
            md.append(
                f"| {var} / {mod} | {len(ms)} | {st.median(ms):.1f} | {ms[len(ms)//4]:.1f}–{ms[3*len(ms)//4]:.1f} | "
                f"{sum(m <= 33.3 for m in ms)}/{len(ms)} | {sum(m <= 33.3 for m in js)}/{len(ms)} | "
                f"{st.mean(AV[n]['frame']/500 for n, _ in xs):,.0f} |"
            )
            ax.scatter(ms, [k] * len(ms), s=16, color=C[k], alpha=0.85, edgecolors="none")
            ax.plot([st.median(ms)] * 2, [k - 0.3, k + 0.3], color=INK, lw=1.5)
        ax.set_yticks(range(len(order)))
        ax.set_yticklabels([f"{v} / {m}" for v, m in order])
        ax.set_xscale("log")
        ax.axvline(33.3, color=INK2, lw=0.8, ls="--")
        ax.text(34, -0.45, "33 ms", fontsize=7, color=INK2)
        ax.set_xlabel(
            "measured frame ms on the C6 (500 LEDs, VM, incl. ~600 cyc/LED firmware framing); bar = median"
        )
        ax.set_title(
            "15 prompts per path: how expensive is what the agents write?", loc="left", fontsize=10
        )
        fig.tight_layout()
        fig.savefig(os.path.join(a.img, "q2-agent-cost.png"), dpi=150)
        plt.close(fig)

    # ---- prototypes / #328 ----------------------------------------------------
    md.append("")
    cols = [k for k in ["pr328", "p1", "p2", "p3"] if R[k]]
    md.append("| effect | main cyc/LED | " + " | ".join(cols) + " |")
    md.append("|---|---:|" + "---:|" * len(cols))
    for e in STUDY:
        base = VM[(e, "helix", 500)]["frame"]
        cells = []
        for k in cols:
            r = by(R[k]).get((e, "helix", 500))
            cells.append(f"{(r['frame']/base-1)*100:+.1f}%" if r else "—")
        md.append(f"| {e} | {base/500:,.0f} | " + " | ".join(cells) + " |")
    for k in cols:
        B = by(R[k])
        us = [(B[x]["frame"] / VM[x]["frame"] - 1) * 100 for x in VM if x[1] == "sign" and x in B]
        if us:
            md.append(
                f"\nuser library (sign @500) {k}: median {st.median(us):+.1f}%, "
                f"best {min(us):+.1f}%, worst {max(us):+.1f}%"
            )
    open(a.md, "w").write("\n".join(md) + "\n")
    print("wrote", a.md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
