"""Load and validate the machine-readable requirements model.

Requirements: PR-40

The model (``requirements/requirements.yaml``) is the single source of truth for
the requirements-driven-development workflow. It holds four entity kinds:

* **UN** — user needs. What a user must be able to do. *Validated* by rolling up
  the verification of the product requirements that satisfy them.
* **PR (direct)** — product requirements that ``satisfies`` one or more user
  needs. *Verified* by the tests that reference them.
* **RISK** — a hazard or failure mode. *Mitigated* when the derived PRs that
  mitigate it are all verified.
* **PR (derived)** — a product requirement that describes a risk mitigation. It
  ``mitigates`` one or more RISKs (and, like any PR, may also ``satisfies`` user
  needs). The relationship is bidirectional: ``RISK.mitigated_by`` must name the
  derived PR and the derived PR's ``mitigates`` must name the RISK.

This module intentionally depends only on PyYAML so it stays importable in any
Bazel sandbox. Schema-shape validation and referential-integrity validation are
both done here (rather than pulling in ``jsonschema``) so a single
``load_model`` call gives an actionable error list.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

import yaml

UN_RE = re.compile(r"^UN-\d+$")
PR_RE = re.compile(r"^PR-\d+$")
RISK_RE = re.compile(r"^RISK-\d+$")

SEVERITIES = ("low", "medium", "high", "critical")


class ValidationError(Exception):
    """Raised when the requirements model is structurally or referentially bad.

    Carries the full list of problems (not just the first) so an author fixing
    ``requirements.yaml`` sees everything at once.
    """

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("requirements model is invalid:\n  - " + "\n  - ".join(errors))


@dataclass(frozen=True)
class UserNeed:
    id: str
    title: str
    description: str = ""


@dataclass(frozen=True)
class Requirement:
    id: str
    title: str
    description: str = ""
    kind: str = "direct"  # "direct" | "derived"
    satisfies: tuple[str, ...] = ()  # UN ids
    mitigates: tuple[str, ...] = ()  # RISK ids (derived PRs only)
    modules: tuple[str, ...] = ()  # implementing module dirs (documentation aid)
    # Bazel test targets that verify this PR at *target* granularity, for
    # languages whose runners do not yet emit per-case traceability tags. The
    # whole target's pass/fail contributes to the PR. See traceability.report.
    verified_by: tuple[str, ...] = ()

    @property
    def is_derived(self) -> bool:
        return self.kind == "derived"


@dataclass(frozen=True)
class Risk:
    id: str
    title: str
    description: str = ""
    severity: str = "medium"
    mitigated_by: tuple[str, ...] = ()  # derived PR ids


@dataclass(frozen=True)
class RequirementsModel:
    meta: dict[str, Any] = field(default_factory=dict)
    user_needs: dict[str, UserNeed] = field(default_factory=dict)
    requirements: dict[str, Requirement] = field(default_factory=dict)
    risks: dict[str, Risk] = field(default_factory=dict)

    # --- convenience accessors -------------------------------------------------
    def direct_requirements(self) -> list[Requirement]:
        return [r for r in self.requirements.values() if not r.is_derived]

    def derived_requirements(self) -> list[Requirement]:
        return [r for r in self.requirements.values() if r.is_derived]

    def requirements_for_need(self, un_id: str) -> list[Requirement]:
        return [r for r in self.requirements.values() if un_id in r.satisfies]

    def requirements_for_risk(self, risk_id: str) -> list[Requirement]:
        return [r for r in self.requirements.values() if risk_id in r.mitigates]

    def known_pr_ids(self) -> set[str]:
        return set(self.requirements)


def _as_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, Iterable):
        return tuple(str(v) for v in value)
    return (str(value),)


def _require_keys(kind: str, idx: int, obj: dict, keys: Iterable[str], errors: list[str]) -> None:
    for key in keys:
        if not obj.get(key):
            ident = obj.get("id", f"#{idx}")
            errors.append(f"{kind} {ident}: missing required field '{key}'")


def parse_model(data: dict[str, Any]) -> tuple[RequirementsModel, list[str]]:
    """Parse an already-deserialised mapping into a model, collecting errors.

    Returns the (best-effort) model and a list of validation errors. Callers
    that want a hard failure should use :func:`load_model`.
    """
    errors: list[str] = []
    if not isinstance(data, dict):
        return RequirementsModel(), ["top-level document must be a mapping"]

    meta = data.get("meta") or {}

    # --- user needs ---
    user_needs: dict[str, UserNeed] = {}
    for i, raw in enumerate(data.get("user_needs") or []):
        _require_keys("UN", i, raw, ("id", "title"), errors)
        uid = raw.get("id", "")
        if uid and not UN_RE.match(uid):
            errors.append(f"UN {uid}: id must match UN-<n>")
        if uid in user_needs:
            errors.append(f"UN {uid}: duplicate id")
        if uid:
            user_needs[uid] = UserNeed(
                id=uid, title=raw.get("title", ""), description=raw.get("description", "")
            )

    # --- product requirements ---
    requirements: dict[str, Requirement] = {}
    for i, raw in enumerate(data.get("product_requirements") or []):
        _require_keys("PR", i, raw, ("id", "title"), errors)
        pid = raw.get("id", "")
        if pid and not PR_RE.match(pid):
            errors.append(f"PR {pid}: id must match PR-<n>")
        if pid in requirements:
            errors.append(f"PR {pid}: duplicate id")
        kind = raw.get("kind", "direct")
        if kind not in ("direct", "derived"):
            errors.append(f"PR {pid}: kind must be 'direct' or 'derived', got {kind!r}")
        if pid:
            requirements[pid] = Requirement(
                id=pid,
                title=raw.get("title", ""),
                description=raw.get("description", ""),
                kind=kind,
                satisfies=_as_tuple(raw.get("satisfies")),
                mitigates=_as_tuple(raw.get("mitigates")),
                modules=_as_tuple(raw.get("modules")),
                verified_by=_as_tuple(raw.get("verified_by")),
            )

    # --- risks ---
    risks: dict[str, Risk] = {}
    for i, raw in enumerate(data.get("risks") or []):
        _require_keys("RISK", i, raw, ("id", "title"), errors)
        rid = raw.get("id", "")
        if rid and not RISK_RE.match(rid):
            errors.append(f"RISK {rid}: id must match RISK-<n>")
        if rid in risks:
            errors.append(f"RISK {rid}: duplicate id")
        sev = raw.get("severity", "medium")
        if sev not in SEVERITIES:
            errors.append(f"RISK {rid}: severity must be one of {SEVERITIES}, got {sev!r}")
        if rid:
            risks[rid] = Risk(
                id=rid,
                title=raw.get("title", ""),
                description=raw.get("description", ""),
                severity=sev,
                mitigated_by=_as_tuple(raw.get("mitigated_by")),
            )

    model = RequirementsModel(
        meta=meta, user_needs=user_needs, requirements=requirements, risks=risks
    )
    errors.extend(_check_references(model))
    return model, errors


def _check_references(model: RequirementsModel) -> list[str]:
    """Referential-integrity checks across the model."""
    errors: list[str] = []

    for pr in model.requirements.values():
        for un in pr.satisfies:
            if un not in model.user_needs:
                errors.append(f"PR {pr.id}: satisfies unknown user need {un}")
        for risk in pr.mitigates:
            if risk not in model.risks:
                errors.append(f"PR {pr.id}: mitigates unknown risk {risk}")
            elif pr.id not in model.risks[risk].mitigated_by:
                errors.append(
                    f"PR {pr.id}: mitigates {risk} but {risk}.mitigated_by does not "
                    f"list {pr.id} (mitigation trace must be bidirectional)"
                )
        if pr.is_derived and not pr.mitigates:
            errors.append(f"PR {pr.id}: derived requirement must mitigate at least one risk")
        if not pr.is_derived and not pr.satisfies:
            errors.append(f"PR {pr.id}: direct requirement must satisfy at least one user need")

    for risk in model.risks.values():
        for pr_id in risk.mitigated_by:
            pr = model.requirements.get(pr_id)
            if pr is None:
                errors.append(f"RISK {risk.id}: mitigated_by unknown requirement {pr_id}")
            elif not pr.is_derived:
                errors.append(
                    f"RISK {risk.id}: mitigated_by {pr_id} which is not a derived requirement "
                    f"(a mitigation must be a derived PR)"
                )
            elif risk.id not in pr.mitigates:
                errors.append(
                    f"RISK {risk.id}: mitigated_by {pr_id} but {pr_id}.mitigates does not "
                    f"list {risk.id} (mitigation trace must be bidirectional)"
                )

    # Every user need should be satisfied by at least one requirement, else it
    # can never be validated. This is a warning-grade problem but we treat it as
    # an error so gaps surface early.
    for un in model.user_needs.values():
        if not model.requirements_for_need(un.id):
            errors.append(f"UN {un.id}: not satisfied by any product requirement")

    return errors


def load_model(path: str) -> RequirementsModel:
    """Load, parse and hard-validate the requirements model at ``path``.

    Raises :class:`ValidationError` with the full problem list on any error.
    """
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    model, errors = parse_model(data)
    if errors:
        raise ValidationError(errors)
    return model
