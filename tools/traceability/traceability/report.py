"""Join the requirements model with test results and render the HTML report.

Requirements: PR-25

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
from traceability.model import (
    DEFAULT_METHOD,
    DEFAULT_PROVIDED,
    INSPECTION,
    Method,
    RequirementsModel,
    method_rank,
)

# The cost pyramid: expensive physical verification (>= HIL) must rest on at
# least one cheap rung (analysis/simulation), not stand alone. A PR that demands
# this rigor but whose only passing evidence is the expensive rung is a policy
# violation (severity configurable at the CLI).
PYRAMID_MIN_RANK = int(Method.HIL)
CHEAP_LEVELS = ("analysis", "simulation")

# Routing boundary for the work queue: demands an agent can satisfy on its own
# (<= SIL) vs. demands needing a bench/DUT (>= HIL, and manual inspection).
AUTONOMOUS_MAX_RANK = int(Method.SIL)
ROUTE_AUTONOMOUS = "autonomous"
ROUTE_HUMAN_GATE = "human-gate"

# Verification/validation verdicts.
VERIFIED = "VERIFIED"  # GREEN — passing evidence meets the demanded rigor
UNDERVERIFIED = "UNDER-VERIFIED"  # AMBER — passing, but below the demanded rigor
STALE = "STALE"  # evidence exists but only against an out-of-date build
FAILED = "FAILED"  # RED — a referencing test failed/errored
UNVERIFIED = "UNVERIFIED"  # no passing evidence
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
    UNDERVERIFIED: "amber",
}


def _best_provided(levels: list[str]) -> tuple[int | None, str]:
    """From a list of provided level names, return (best ordered rank, display).

    The highest ranked ordered level wins; ``inspection`` (unordered) is only
    surfaced when no ordered level is present. Returns (None, "") for no levels.
    """
    best_rank: int | None = None
    best_name = ""
    has_inspection = False
    for lvl in levels:
        name = (lvl or DEFAULT_PROVIDED).strip().lower()
        rank = method_rank(name)
        if rank is None:  # inspection / unknown
            has_inspection = has_inspection or name == INSPECTION
            continue
        if best_rank is None or rank > best_rank:
            best_rank, best_name = rank, name
    if best_rank is None and has_inspection:
        return None, INSPECTION
    return best_rank, best_name


def _classify(passed_levels: list[str], failed: list[str], demanded: str) -> tuple[str, str]:
    """Verdict + best-provided-level display for one PR's evidence.

    GREEN when a passing artifact's rigor meets/exceeds the demanded method;
    AMBER (UNDER-VERIFIED) when there is passing evidence but all of it is below
    the demand; RED (FAILED) on any failure; UNVERIFIED with no passing evidence.
    """
    if failed:
        return FAILED, ""
    if not passed_levels:
        return UNVERIFIED, ""
    demanded_rank = method_rank(demanded)
    best_rank, best_name = _best_provided(passed_levels)
    if demanded_rank is None:  # inspection demand — met only by inspection evidence
        return (VERIFIED if best_name == INSPECTION else UNDERVERIFIED), best_name
    if best_rank is not None and best_rank >= demanded_rank:
        return VERIFIED, best_name
    return UNDERVERIFIED, best_name


def _is_stale(artifact: dict, current: dict | None) -> bool:
    """True when the artifact identity a result recorded differs from the current
    build's identity. Only keys present in *both* are compared; a result with no
    identity, or no current reference to compare against, is never stale."""
    if not artifact or not current:
        return False
    return any(k in current and str(current[k]) != str(v) for k, v in artifact.items())


def _pyramid_violation(demanded: str, passed_levels: list[str]) -> bool:
    """True when an expensive-rigor PR rests only on the expensive rung.

    A PR that demands >= HIL and has passing evidence, but none of it at an
    ``analysis``/``simulation`` level, violates the cost pyramid: cheap
    verification should back the physical result, not be skipped.
    """
    demanded_rank = method_rank(demanded)
    if demanded_rank is None or demanded_rank < PYRAMID_MIN_RANK:
        return False
    if not passed_levels:
        return False  # nothing to verify yet — that's UNVERIFIED, not a violation
    return not any(
        (lvl or DEFAULT_PROVIDED).strip().lower() in CHEAP_LEVELS for lvl in passed_levels
    )


@dataclass
class PrEvidence:
    pr_id: str
    status: str
    demanded: str = DEFAULT_METHOD  # rigor this PR demands
    provided: str = ""  # best passing rigor level, "" if none
    provided_levels: list[str] = field(default_factory=list)  # every passing artifact's level
    pyramid_violation: bool = False  # demands >= HIL but has no cheap rung
    stale: bool = False  # only passing evidence is against an out-of-date build
    passed: list[str] = field(default_factory=list)  # test full-names / targets
    failed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


@dataclass
class Matrix:
    model: RequirementsModel
    pr_status: dict[str, PrEvidence]
    un_status: dict[str, str]
    risk_status: dict[str, str]

    def pyramid_violations(self) -> list[str]:
        """PR ids that rest only on expensive (>= HIL) evidence (cost-pyramid policy)."""
        return [e.pr_id for e in self.pr_status.values() if e.pyramid_violation]

    def high_open_risks(self) -> list[str]:
        """High/critical-severity risks whose mitigation is not fully verified.

        Mitigation is not elimination: a high risk mitigated only by an
        unverified/under-verified derived PR must surface loudly, not vanish
        into a checkmark.
        """
        return [
            rid
            for rid, risk in self.model.risks.items()
            if risk.is_high and self.risk_status.get(rid) != MITIGATED
        ]

    def counts(self) -> dict[str, int]:
        prs = list(self.pr_status.values())
        return {
            "prs": len(prs),
            "pr_verified": sum(1 for e in prs if e.status == VERIFIED),
            "pr_underverified": sum(1 for e in prs if e.status == UNDERVERIFIED),
            "pr_failed": sum(1 for e in prs if e.status == FAILED),
            "pr_unverified": sum(1 for e in prs if e.status == UNVERIFIED),
            "uns": len(self.un_status),
            "un_validated": sum(1 for s in self.un_status.values() if s == VALIDATED),
            "risks": len(self.risk_status),
            "risk_mitigated": sum(1 for s in self.risk_status.values() if s == MITIGATED),
        }


def build_matrix(
    model: RequirementsModel, results: JUnitResults, current_build: dict | None = None
) -> Matrix:
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
        # Each passing artifact's provided level, split by whether its recorded
        # build identity is still current.
        fresh_levels: list[str] = []
        stale_levels: list[str] = []
        for case in fine.get(pr_id, []):
            bucket = {"passed": passed, "failed": failed, "error": failed, "skipped": skipped}[
                case.status
            ]
            bucket.append(case.full_name)
            if case.status == "passed":
                lvl = case.level or DEFAULT_PROVIDED
                (stale_levels if _is_stale(case.artifact, current_build) else fresh_levels).append(
                    lvl
                )
        for vb in pr.verified_by:
            status = results.target_status.get(vb.target)
            if status is None:
                continue
            label = f"{vb.target} (target, {vb.level})"
            {"passed": passed, "failed": failed, "error": failed, "skipped": skipped}[
                status
            ].append(label)
            if status == "passed":
                fresh_levels.append(vb.level or DEFAULT_PROVIDED)  # targets carry no DUT identity

        # Fresh evidence decides the verdict; if the only passing evidence is
        # stale, the PR is AMBER-stale rather than GREEN.
        if fresh_levels or failed or not stale_levels:
            status, provided = _classify(fresh_levels, failed, pr.method)
            stale_flag = False
        else:
            status, provided = UNDERVERIFIED, _best_provided(stale_levels)[1]
            stale_flag = True
        all_levels = fresh_levels + stale_levels
        pr_status[pr_id] = PrEvidence(
            pr_id=pr_id,
            status=status,
            demanded=pr.method,
            provided=provided,
            provided_levels=all_levels,
            pyramid_violation=_pyramid_violation(pr.method, all_levels),
            stale=stale_flag,
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
    # Any GREEN or AMBER child is progress but not full validation/mitigation.
    if any(s in (VERIFIED, UNDERVERIFIED) for s in statuses):
        return PARTIAL
    return none_ok


def route_for(method: str) -> str:
    """Where a gap for a PR of this demanded method should go.

    <= SIL: an agent may write the missing analysis/sim/SIL test (autonomous).
    >= HIL, or manual inspection: needs a bench/DUT or a human — the agent may
    only prepare the harness and open the gate, never synthesise the evidence.
    """
    rank = method_rank(method)
    if rank is not None and rank <= AUTONOMOUS_MAX_RANK:
        return ROUTE_AUTONOMOUS
    return ROUTE_HUMAN_GATE


def build_queue(matrix: Matrix) -> list[dict]:
    """The report's gaps as a machine-readable work queue.

    One entry per PR that is UNVERIFIED, UNDER-VERIFIED or STALE, carrying the
    gap type, demanded method, best provided level, and the route derived from
    the demanded method. This is the agentic feedback loop: autonomous items an
    agent can close, human-gate items it must hand off (see docs).
    """
    queue: list[dict] = []
    for pr_id in sorted(matrix.pr_status, key=lambda p: (len(p), p)):
        ev = matrix.pr_status[pr_id]
        if ev.stale:
            gap = "stale"
        elif ev.status == UNVERIFIED:
            gap = "unverified"
        elif ev.status == UNDERVERIFIED:
            gap = "under-verified"
        else:
            continue
        queue.append(
            {
                "pr": pr_id,
                "gap": gap,
                "demanded_method": ev.demanded,
                "provided_level": ev.provided or None,
                "route": route_for(ev.demanded),
            }
        )
    return queue


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
        # Method line: demanded rigor, and (when AMBER) the best rigor provided.
        if ev.status == UNDERVERIFIED:
            method_cell = (
                f"demands <b>{_esc(ev.demanded)}</b>"
                f" &middot; best provided <b>{_esc(ev.provided or '—')}</b>"
            )
        else:
            method_cell = f"demands <b>{_esc(ev.demanded)}</b>"
        badge = _badge(ev.status)
        if ev.stale:
            badge += " <span class='badge stale'>STALE</span>"
            method_cell += (
                " &middot; <span class='stale-text'>evidence is against an old build</span>"
            )
        rows_pr.append(
            f"<tr id='{pr.id}'><td class='id'>{_esc(pr.id)}"
            f"<div class='kind {kind}'>{kind}</div></td>"
            f"<td>{_esc(pr.title)}<div class='desc'>{_esc(pr.description)}</div>"
            f"<div class='trace'>{_esc('; '.join(trace))}</div></td>"
            f"<td>{evidence}<div class='method'>{method_cell}</div></td>"
            f"<td>{badge}</td></tr>"
        )

    rows_risk = []
    for risk in sorted(model.risks.values(), key=lambda r: r.id):
        prs = model.requirements_for_risk(risk.id)
        pr_cells = (
            ", ".join(f'<a href="#{p.id}">{p.id}</a>' for p in sorted(prs, key=lambda r: r.id))
            or "<span class='muted'>none</span>"
        )
        meta_bits = []
        if risk.likelihood:
            meta_bits.append(f"likelihood: {risk.likelihood}")
        if risk.residual:
            meta_bits.append(f"residual: {risk.residual}")
        meta_line = f"<div class='trace'>{_esc(' · '.join(meta_bits))}</div>" if meta_bits else ""
        rows_risk.append(
            f"<tr id='{risk.id}'><td class='id'>{_esc(risk.id)}"
            f"<div class='kind sev-{_esc(risk.severity)}'>{_esc(risk.severity)}</div></td>"
            f"<td>{_esc(risk.title)}<div class='desc'>{_esc(risk.description)}</div>"
            f"{meta_line}</td>"
            f"<td>{pr_cells}</td>"
            f"<td>{_badge(matrix.risk_status[risk.id])}</td></tr>"
        )

    summary = (
        f"<b>{c['un_validated']}/{c['uns']}</b> user needs validated &middot; "
        f"<b>{c['pr_verified']}/{c['prs']}</b> requirements verified "
        f"(<span class='amber-text'>{c['pr_underverified']} under-verified</span>, "
        f"<span class='fail-text'>{c['pr_failed']} failed</span>, "
        f"{c['pr_unverified']} unverified) &middot; "
        f"<b>{c['risk_mitigated']}/{c['risks']}</b> risks mitigated"
    )

    high_open = matrix.high_open_risks()
    if high_open:
        risk_items = "".join(
            f'<li><a href="#{rid}">{_esc(rid)}</a> '
            f"<b>({_esc(model.risks[rid].severity)})</b> "
            f"{_esc(model.risks[rid].title)} &mdash; "
            f"mitigation {_esc(matrix.risk_status[rid])}</li>"
            for rid in sorted(high_open, key=lambda r: (len(r), r))
        )
        risk_alert = (
            "<div class='policy alert'><b>High-severity risks not mitigated:</b> "
            f"{len(high_open)} require attention."
            f"<ul>{risk_items}</ul></div>"
        )
    else:
        risk_alert = ""

    violations = matrix.pyramid_violations()
    if violations:
        items = "".join(
            f'<li><a href="#{v}">{_esc(v)}</a> demands '
            f"<b>{_esc(matrix.pr_status[v].demanded)}</b> but has no analysis/simulation "
            f"evidence backing the physical result</li>"
            for v in sorted(violations)
        )
        policy = (
            "<div class='policy'><b>Cost-pyramid policy:</b> "
            f"{len(violations)} requirement(s) rest only on expensive (&ge; HIL) evidence."
            f"<ul>{items}</ul></div>"
        )
    else:
        policy = (
            "<div class='policy ok'><b>Cost-pyramid policy:</b> every physical-rigor "
            "requirement with evidence is also backed by cheaper analysis/simulation.</div>"
        )

    return _TEMPLATE.format(
        title=_esc(title),
        summary=summary,
        risk_alert=risk_alert,
        policy=policy,
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
  .badge.amber {{ background: #d9770622; color: #e8890c; }}
  .badge.stale {{ background: #7c3aed22; color: #a06bff; }}
  .stale-text {{ color: #a06bff; }}
  ul.ev {{ margin: 0; padding-left: 1.1rem; font-size: .82rem; }}
  ul.ev.pass li {{ color: #3ba55d; }}
  ul.ev.fail li {{ color: #e05252; }}
  ul.ev.skip li {{ color: #999; }}
  .method {{ color: #888; font-size: .78rem; margin-top: .3rem;
            font-family: ui-monospace, monospace; }}
  .muted, .fail-text {{ color: #999; font-size: .85rem; }}
  .fail-text {{ color: #e05252; }}
  .amber-text {{ color: #e8890c; }}
  .policy {{ margin: .75rem 0; padding: .6rem .9rem; border-radius: 8px;
            background: #c9910018; border-left: 3px solid #d9a023; font-size: .9rem; }}
  .policy.ok {{ background: #2e7d3212; border-left-color: #3ba55d; }}
  .policy.alert {{ background: #c6282818; border-left-color: #e05252; }}
  .policy ul {{ margin: .4rem 0 0; padding-left: 1.1rem; }}
</style></head>
<body>
<h1>{title}</h1>
<div class="summary">{summary}</div>
{risk_alert}
{policy}
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
