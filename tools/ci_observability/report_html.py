#!/usr/bin/env python3
"""Render the normalized CI records into a self-contained static HTML report.

No external assets, no JS libraries — inline CSS plus pure-CSS/HTML bar charts
and native ``<details>`` disclosure — so the single .html file works when opened
straight from a downloaded CI artifact. It's meant to be uploaded by every
Bazel-running GitHub job and linked from the job summary (FUG-128).
"""

from __future__ import annotations

import datetime as _dt
import html
from collections import defaultdict

# Status -> (label, css class) for the badges/rows.
_STATUS_STYLE = {
    "PASSED": ("passed", "pass"),
    "FAILED": ("failed", "fail"),
    "TIMEOUT": ("timeout", "fail"),
    "ERROR": ("error", "fail"),
    "BUILD_FAILED": ("build failed", "fail"),
    "FLAKY": ("flaky", "flaky"),
    "SKIPPED": ("skipped", "skip"),
}

_CSS = """
:root{--bg:#0f1116;--panel:#181b23;--panel2:#1f232d;--fg:#e6e9ef;--muted:#9aa4b2;
--pass:#3fb950;--fail:#f85149;--flaky:#d29922;--skip:#6e7681;--accent:#58a6ff;--border:#2a2f3a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:28px 0 10px;color:var(--fg)}
.sub{color:var(--muted);margin-bottom:20px;font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
padding:14px 18px;min-width:120px}
.card .n{font-size:26px;font-weight:700}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.card.pass .n{color:var(--pass)} .card.fail .n{color:var(--fail)}
.card.flaky .n{color:var(--flaky)} .card.skip .n{color:var(--skip)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px}
.bar-row{display:grid;grid-template-columns:220px 1fr 48px;gap:10px;align-items:center;margin:6px 0}
.bar-label{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.bar-track{background:var(--panel2);border-radius:5px;height:16px;overflow:hidden}
.bar-fill{height:100%;background:linear-gradient(90deg,#f85149,#d29922)}
.bar-fill.cat-disk,.bar-fill.cat-memory,.bar-fill.cat-network{background:linear-gradient(90deg,#d29922,#e3b341)}
.bar-fill.cat-build{background:linear-gradient(90deg,#a371f7,#8957e5)}
.bar-fill.cat-assertion{background:linear-gradient(90deg,#f85149,#da3633)}
.bar-val{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge.pass{background:rgba(63,185,80,.15);color:var(--pass)}
.badge.fail{background:rgba(248,81,73,.15);color:var(--fail)}
.badge.flaky{background:rgba(210,153,34,.15);color:var(--flaky)}
.badge.skip{background:rgba(110,118,129,.15);color:var(--skip)}
details{background:var(--panel);border:1px solid var(--border);border-radius:10px;margin:8px 0;overflow:hidden}
details[open]{border-color:#39414f}
summary{cursor:pointer;padding:10px 14px;list-style:none;display:flex;gap:10px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted);transition:transform .1s}
details[open] summary::before{transform:rotate(90deg)}
summary .t{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
summary .meta{color:var(--muted);margin-left:auto;font-size:12px}
.det-body{padding:0 14px 12px}
pre{background:#0b0d12;border:1px solid var(--border);border-radius:8px;padding:10px 12px;
overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d6deeb;max-height:340px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cat{display:inline-block;padding:0 6px;border-radius:4px;background:var(--panel2);color:var(--muted);font-size:11px}
.empty{color:var(--muted);padding:20px;text-align:center}
.logwrap{margin-top:8px}
.logcap{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px}
.heat{display:flex;flex-wrap:wrap;gap:4px}
.heat .cell{width:16px;height:16px;border-radius:3px;background:var(--panel2)}
footer{color:var(--muted);font-size:12px;margin-top:32px;border-top:1px solid var(--border);padding-top:14px}
"""


def _esc(s) -> str:
    return html.escape(str(s or ""))


def _bars(rows, total, cat_class=False) -> str:
    if not rows:
        return '<div class="empty">none 🎉</div>'
    mx = max(n for _, n in rows) or 1
    out = ['<div class="panel">']
    for label, n in rows:
        pct = int(100 * n / mx)
        cls = f"cat-{_esc(label)}" if cat_class else ""
        out.append(
            f'<div class="bar-row"><div class="bar-label" title="{_esc(label)}">{_esc(label)}</div>'
            f'<div class="bar-track"><div class="bar-fill {cls}" style="width:{pct}%"></div></div>'
            f'<div class="bar-val">{n}</div></div>'
        )
    out.append("</div>")
    return "".join(out)


def _target_details(records) -> str:
    """Collapsible per-target block with each test case + failure trace."""
    by_target = defaultdict(list)
    for r in records:
        by_target[r.target].append(r)

    # Failing targets first, then by name.
    def target_key(item):
        label, recs = item
        has_fail = any(r.is_failure() for r in recs)
        return (0 if has_fail else 1, label)

    blocks = []
    for label, recs in sorted(by_target.items(), key=target_key):
        fails = [r for r in recs if r.is_failure()]
        total = len(recs)
        status_cls = (
            "fail" if fails else ("flaky" if any(r.status == "FLAKY" for r in recs) else "pass")
        )
        badge = "fail" if fails else ("flaky" if status_cls == "flaky" else "pass")
        badge_txt = f"{len(fails)} failed" if fails else "passed"
        rows = []
        for r in sorted(recs, key=lambda x: (not x.is_failure(), x.test_case)):
            _lbl, cls = _STATUS_STYLE.get(r.status, ("?", "fail"))
            case = _esc(r.test_case or "(target)")
            dur = f"{r.duration_ms/1000:.2f}s" if r.duration_ms else ""
            reason = ""
            if r.is_failure():
                reason = (
                    f'<div><span class="cat">{_esc(r.failure_category)}</span> '
                    f"{_esc(r.failure_reason)}</div>"
                )
                if r.failure_trace:
                    reason += f"<pre>{_esc(r.failure_trace)}</pre>"
            rows.append(
                f'<tr><td><span class="badge {cls}">{_esc(r.status)}</span></td>'
                f'<td class="mono">{case}{reason}</td>'
                f'<td class="bar-val">{dur}</td></tr>'
            )
        # The target's log (test.log / build stderr), shown for every target —
        # pass or fail — so expanding a target always reveals its output.
        log = ""
        logs = [r.log_excerpt for r in recs if r.log_excerpt]
        if logs:
            log = max(logs, key=len)  # identical per run; pick the fullest
        log_block = (
            f'<div class="logwrap"><div class="logcap">log</div><pre>{_esc(log)}</pre></div>'
            if log
            else '<div class="logcap">no log captured</div>'
        )
        blocks.append(
            f'<details{" open" if fails else ""}>'
            f'<summary><span class="t">{_esc(label)}</span>'
            f'<span class="meta"><span class="badge {badge}">{badge_txt}</span> · {total} case(s)</span></summary>'
            f'<div class="det-body"><table><thead><tr><th>Status</th><th>Test case</th><th>Time</th></tr></thead>'
            f"<tbody>{''.join(rows)}</tbody></table>{log_block}</div></details>"
        )
    return "".join(blocks) if blocks else '<div class="empty">no targets in this run</div>'


def _console_section(console) -> str:
    """A collapsible block with the full bazel console output (compiler errors)."""
    if not console:
        return ""
    return (
        "<h2>Console output</h2>"
        "<details><summary><span class='t'>bazel console (stderr/stdout)</span></summary>"
        f"<div class='det-body'><pre>{_esc(console)}</pre></div></details>"
    )


def render_html(records, summary, context, console="") -> str:
    now = (
        _dt.datetime.now(tz=_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    ctx = context or {}
    title_bits = [b for b in [ctx.get("workflow"), ctx.get("job")] if b]
    title = " · ".join(title_bits) or "CI run"

    cards = "".join(
        f'<div class="card {cls}"><div class="n">{summary[key]}</div><div class="l">{lbl}</div></div>'
        for key, lbl, cls in [
            ("total", "total", ""),
            ("passed", "passed", "pass"),
            ("failed", "failed", "fail"),
            ("flaky", "flaky", "flaky"),
            ("skipped", "skipped", "skip"),
        ]
    )

    meta_bits = []
    for k in ("runner", "commit", "branch", "pr", "invocation"):
        v = ctx.get(k) if k != "invocation" else None
        if k == "commit" and v:
            v = v[:10]
        if v:
            meta_bits.append(f"{k}: <span class='mono'>{_esc(v)}</span>")
    run_url = ctx.get("run_url")
    sub = " · ".join(meta_bits)
    if run_url:
        sub += f" · <a href='{_esc(run_url)}'>run log</a>"

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CI report — {_esc(title)}</title>
<style>{_CSS}</style></head>
<body><div class="wrap">
<h1>CI report — {_esc(title)}</h1>
<div class="sub">{sub or "generated by tools/ci_observability"}</div>
<div class="cards">{cards}</div>

<h2>Failures by category</h2>
{_bars(summary["by_category"], summary["failed"], cat_class=True)}

<h2>Failures by signature (aggregated by trace)</h2>
{_bars([(s, n) for s, n in summary["by_signature"]], summary["failed"])}

<h2>Failures by runner / DUT</h2>
{_bars(summary["by_runner"], summary["failed"])}

<h2>Failures by target</h2>
{_bars(summary["by_target"], summary["failed"])}

<h2>Per-target details</h2>
{_target_details(records)}

{_console_section(console)}
<footer>Generated {now} by <span class="mono">tools/ci_observability/bep_report.py</span>
from the Bazel Build Event Protocol.</footer>
</div></body></html>
"""
