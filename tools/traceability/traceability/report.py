"""Join the requirements model with test results and render the HTML report.

Requirements: PR-43

The report answers, for the whole UN/PR/RISK listing:

* **Verification** — is each product requirement (PR) exercised by a passing
  test? A PR is VERIFIED when at least one test that references it passed and
  none failed; FAILED when any referencing test failed/errored; UNVERIFIED when
  no test references it.
* **Validation** — is each user need (UN) met? Rolled up from the verification
  of the PRs that satisfy it.
* **Risk mitigation** — is each RISK controlled? Rolled up from the verification
  of the derived PRs that mitigate it.

Traceability comes from two places, unioned per PR: per-testcase ``requirement``
tags (see :mod:`traceability.junit`) and, for PRs with ``verified_by`` target
labels, the pass/fail of those Bazel targets.
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field

from traceability.junit import CaseResult, JUnitResults
from traceability.model import RequirementsModel

# Verification/validation verdicts.
VERIFIED = "VERIFIED"
FAILED = "FAILED"
UNVERIFIED = "UNVERIFIED"
VALIDATED = "VALIDATED"
PARTIAL = "PARTIAL"
MITIGATED = "MITIGATED"
OPEN = "OPEN"

_BADGE_CLASS = {
    VERIFIED: "ok",
    VALIDATED: "ok",
    MITIGATED: "ok",
    FAILED: "fail",
    UNVERIFIED: "none",
    OPEN: "none",
    PARTIAL: "warn",
}


@dataclass
class PrEvidence:
    pr_id: str
    status: str
    passed: list[str] = field(default_factory=list)  # test full-names / targets
    failed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


@dataclass
class Matrix:
    model: RequirementsModel
    pr_status: dict[str, PrEvidence]
    un_status: dict[str, str]
    risk_status: dict[str, str]

    def counts(self) -> dict[str, int]:
        prs = list(self.pr_status.values())
        return {
            "prs": len(prs),
            "pr_verified": sum(1 for e in prs if e.status == VERIFIED),
            "pr_failed": sum(1 for e in prs if e.status == FAILED),
            "pr_unverified": sum(1 for e in prs if e.status == UNVERIFIED),
            "uns": len(self.un_status),
            "un_validated": sum(1 for s in self.un_status.values() if s == VALIDATED),
            "risks": len(self.risk_status),
            "risk_mitigated": sum(1 for s in self.risk_status.values() if s == MITIGATED),
        }


def _pr_verdict(passed: list[str], failed: list[str], skipped: list[str]) -> str:
    if failed:
        return FAILED
    if passed:
        return VERIFIED
    return UNVERIFIED  # only skipped, or nothing


def build_matrix(model: RequirementsModel, results: JUnitResults) -> Matrix:
    # --- per-PR evidence, unioning fine-grained tags and coarse targets ---
    fine: dict[str, list[CaseResult]] = {}
    for case in results.cases:
        for pr_id in case.requirements:
            fine.setdefault(pr_id, []).append(case)

    pr_status: dict[str, PrEvidence] = {}
    for pr_id, pr in model.requirements.items():
        passed: list[str] = []
        failed: list[str] = []
        skipped: list[str] = []
        for case in fine.get(pr_id, []):
            bucket = {"passed": passed, "failed": failed, "error": failed, "skipped": skipped}[
                case.status
            ]
            bucket.append(case.full_name)
        for target in pr.verified_by:
            status = results.target_status.get(target)
            if status is None:
                continue
            label = f"{target} (target)"
            {"passed": passed, "failed": failed, "error": failed, "skipped": skipped}[
                status
            ].append(label)
        pr_status[pr_id] = PrEvidence(
            pr_id=pr_id,
            status=_pr_verdict(passed, failed, skipped),
            passed=passed,
            failed=failed,
            skipped=skipped,
        )

    # --- user-need validation rolls up its satisfying PRs ---
    un_status: dict[str, str] = {}
    for un_id in model.user_needs:
        statuses = [pr_status[r.id].status for r in model.requirements_for_need(un_id)]
        un_status[un_id] = _rollup(statuses, all_ok=VALIDATED)

    # --- risk mitigation rolls up its mitigating derived PRs ---
    risk_status: dict[str, str] = {}
    for risk_id in model.risks:
        statuses = [pr_status[r.id].status for r in model.requirements_for_risk(risk_id)]
        risk_status[risk_id] = _rollup(statuses, all_ok=MITIGATED, empty=OPEN, none_ok=OPEN)

    return Matrix(model=model, pr_status=pr_status, un_status=un_status, risk_status=risk_status)


def _rollup(
    statuses: list[str], *, all_ok: str, empty: str = UNVERIFIED, none_ok: str = UNVERIFIED
) -> str:
    if not statuses:
        return empty
    if any(s == FAILED for s in statuses):
        return FAILED
    if all(s == VERIFIED for s in statuses):
        return all_ok
    if any(s == VERIFIED for s in statuses):
        return PARTIAL
    return none_ok


# --------------------------------------------------------------------------- #
# HTML rendering                                                              #
# --------------------------------------------------------------------------- #


def _esc(text: str) -> str:
    return html.escape(str(text))


def _badge(status: str) -> str:
    cls = _BADGE_CLASS.get(status, "none")
    return f'<span class="badge {cls}">{_esc(status)}</span>'


def _evidence_list(items: list[str], cls: str) -> str:
    if not items:
        return ""
    lis = "".join(f"<li>{_esc(i)}</li>" for i in items)
    return f'<ul class="ev {cls}">{lis}</ul>'


def render_html(matrix: Matrix, title: str = "splanc requirements traceability") -> str:
    model = matrix.model
    c = matrix.counts()

    rows_un = []
    for un in model.user_needs.values():
        prs = model.requirements_for_need(un.id)
        pr_cells = ", ".join(
            f'<a href="#{p.id}">{p.id}</a>' for p in sorted(prs, key=lambda r: r.id)
        )
        rows_un.append(
            f"<tr id='{un.id}'><td class='id'>{_esc(un.id)}</td>"
            f"<td>{_esc(un.title)}<div class='desc'>{_esc(un.description)}</div></td>"
            f"<td>{pr_cells}</td>"
            f"<td>{_badge(matrix.un_status[un.id])}</td></tr>"
        )

    rows_pr = []
    for pr in sorted(model.requirements.values(), key=lambda r: r.id):
        ev = matrix.pr_status[pr.id]
        trace = []
        if pr.satisfies:
            trace.append("satisfies " + ", ".join(pr.satisfies))
        if pr.mitigates:
            trace.append("mitigates " + ", ".join(pr.mitigates))
        if pr.modules:
            trace.append("modules: " + ", ".join(pr.modules))
        kind = "derived" if pr.is_derived else "direct"
        evidence = (
            _evidence_list(ev.passed, "pass")
            + _evidence_list(ev.failed, "fail")
            + _evidence_list(ev.skipped, "skip")
        ) or "<span class='muted'>no tests reference this PR</span>"
        rows_pr.append(
            f"<tr id='{pr.id}'><td class='id'>{_esc(pr.id)}"
            f"<div class='kind {kind}'>{kind}</div></td>"
            f"<td>{_esc(pr.title)}<div class='desc'>{_esc(pr.description)}</div>"
            f"<div class='trace'>{_esc('; '.join(trace))}</div></td>"
            f"<td>{evidence}</td>"
            f"<td>{_badge(ev.status)}</td></tr>"
        )

    rows_risk = []
    for risk in sorted(model.risks.values(), key=lambda r: r.id):
        prs = model.requirements_for_risk(risk.id)
        pr_cells = (
            ", ".join(f'<a href="#{p.id}">{p.id}</a>' for p in sorted(prs, key=lambda r: r.id))
            or "<span class='muted'>none</span>"
        )
        rows_risk.append(
            f"<tr id='{risk.id}'><td class='id'>{_esc(risk.id)}"
            f"<div class='kind sev-{_esc(risk.severity)}'>{_esc(risk.severity)}</div></td>"
            f"<td>{_esc(risk.title)}<div class='desc'>{_esc(risk.description)}</div></td>"
            f"<td>{pr_cells}</td>"
            f"<td>{_badge(matrix.risk_status[risk.id])}</td></tr>"
        )

    summary = (
        f"<b>{c['un_validated']}/{c['uns']}</b> user needs validated &middot; "
        f"<b>{c['pr_verified']}/{c['prs']}</b> requirements verified "
        f"(<span class='fail-text'>{c['pr_failed']} failed</span>, "
        f"{c['pr_unverified']} unverified) &middot; "
        f"<b>{c['risk_mitigated']}/{c['risks']}</b> risks mitigated"
    )

    return _TEMPLATE.format(
        title=_esc(title),
        summary=summary,
        source=_esc(model.meta.get("source", "")),
        rows_un="\n".join(rows_un),
        rows_pr="\n".join(rows_pr),
        rows_risk="\n".join(rows_risk),
    )


_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem;
         max-width: 1100px; margin-inline: auto; }}
  h1 {{ font-size: 1.6rem; margin: 0 0 .25rem; }}
  h2 {{ margin: 2rem 0 .5rem; font-size: 1.2rem; }}
  .summary {{ font-size: 1.05rem; padding: .75rem 1rem; background: #8881;
             border-radius: 8px; }}
  .source {{ color: #888; font-size: .85rem; margin: .5rem 0 0; }}
  table {{ border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }}
  th, td {{ text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #8883;
           vertical-align: top; }}
  th {{ position: sticky; top: 0; background: Canvas; border-bottom: 2px solid #8886; }}
  td.id {{ font-family: ui-monospace, monospace; white-space: nowrap; font-weight: 600; }}
  .desc {{ color: #888; font-size: .85rem; margin-top: .15rem; }}
  .trace {{ color: #6a9; font-size: .8rem; margin-top: .25rem; font-family: ui-monospace, monospace; }}
  .kind {{ display: inline-block; font-size: .7rem; font-weight: 500; color: #aaa;
          text-transform: uppercase; letter-spacing: .04em; margin-top: .2rem; }}
  .kind.derived {{ color: #b48ead; }}
  .sev-high, .sev-critical {{ color: #d67; }}
  .badge {{ display: inline-block; padding: .15rem .5rem; border-radius: 999px;
           font-size: .78rem; font-weight: 700; }}
  .badge.ok {{ background: #2e7d3222; color: #3ba55d; }}
  .badge.fail {{ background: #c6282822; color: #e05252; }}
  .badge.none {{ background: #8882; color: #999; }}
  .badge.warn {{ background: #c9910022; color: #d9a023; }}
  ul.ev {{ margin: 0; padding-left: 1.1rem; font-size: .82rem; }}
  ul.ev.pass li {{ color: #3ba55d; }}
  ul.ev.fail li {{ color: #e05252; }}
  ul.ev.skip li {{ color: #999; }}
  .muted, .fail-text {{ color: #999; font-size: .85rem; }}
  .fail-text {{ color: #e05252; }}
</style></head>
<body>
<h1>{title}</h1>
<div class="summary">{summary}</div>
<p class="source">{source}</p>

<h2>User needs &mdash; validation</h2>
<table><thead><tr><th>UN</th><th>Need</th><th>Requirements</th><th>Validation</th></tr></thead>
<tbody>
{rows_un}
</tbody></table>

<h2>Product requirements &mdash; verification</h2>
<table><thead><tr><th>PR</th><th>Requirement</th><th>Evidence</th><th>Verification</th></tr></thead>
<tbody>
{rows_pr}
</tbody></table>

<h2>Risks &mdash; mitigation</h2>
<table><thead><tr><th>RISK</th><th>Hazard</th><th>Mitigating PRs</th><th>Status</th></tr></thead>
<tbody>
{rows_risk}
</tbody></table>
</body></html>
"""
