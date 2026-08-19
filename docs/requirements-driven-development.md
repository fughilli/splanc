# Requirements-driven development

This repo practises **requirements-driven development (RDD)**: every requirement
is written down in a machine-readable model, every module documents the
requirements it implements, every test declares the requirements it verifies,
and a CI action aggregates the test results into a report that shows, for the
whole listing, whether each user need is **validated** and each requirement
**verified**.

This closes the loop end to end — a requirement with no verifying test, a test
referencing a requirement that no longer exists, or a risk with no working
mitigation all surface automatically (FUG-89).

## The entity model

The source of truth is [`requirements/requirements.yaml`](../requirements/requirements.yaml),
validated against [`requirements/schema.json`](../requirements/schema.json).

| Kind                          | Prefix  | Meaning                                                     | Status question                           |
| ----------------------------- | ------- | ----------------------------------------------------------- | ----------------------------------------- |
| User need                     | `UN-`   | What a user must be able to do.                             | **Validated?** (rolls up its PRs)         |
| Product requirement (direct)  | `PR-`   | `satisfies` one or more user needs.                         | **Verified?** (its tests pass)            |
| Risk                          | `RISK-` | A hazard or failure mode.                                   | **Mitigated?** (rolls up its derived PRs) |
| Product requirement (derived) | `PR-`   | `mitigates` one or more risks (and may also satisfy needs). | **Verified?**                             |

The traces are bidirectional and validated: a derived PR's `mitigates` must name
the risk, and the risk's `mitigated_by` must name the derived PR. A direct PR
must satisfy at least one user need; a derived PR must mitigate at least one
risk; every user need must be satisfied by at least one PR. Broken or dangling
traces fail [`//requirements:requirements_valid_test`](../requirements/validate_test.py).

```yaml
product_requirements:
  - id: PR-34
    title: Pin the wire schema with cross-language conformance tests
    kind: derived
    satisfies: [UN-3, UN-4, UN-6, UN-7]
    mitigates: [RISK-9]
    modules: [shared/protocol, pi/server, web]
    verified_by: ['//web:proto_test'] # coarse, per-target traceability (see below)
risks:
  - id: RISK-9
    title: Binary schema or protocol drift across components
    severity: high
    mitigated_by: [PR-34]
```

> The model content is the FUG-88 "Draft requirements and risk assessment for
> Splanc" baseline (UN-1..8, PR-1..25, RISK-1..12), translated verbatim. The
> per-risk mitigations FUG-88 states as prose are captured here as derived PRs
> (PR-26..37).

## Documenting a module

Each module's `BUILD.bazel` docstring carries a line naming the PRs it
implements:

```python
"""pi/led_driver — SK9822/APA102 Gray-code pattern driver.

Requirements (PRs implemented here; see requirements/requirements.yaml): PR-11
"""
```

Python modules in the traceability toolkit also use an inline `Requirements: PR-…`
line in their docstring. Any file with such a line (source, test, or `BUILD`) is
scanned by `//requirements:check_annotations`, which fails if a referenced id is
not defined in the model.

## Annotating a test

Tests declare the requirements they verify with the `@requirements` marker. For
a whole test module, use a module-level `pytestmark`:

```python
import pytest

# Traceability: PR(s) this suite verifies.
pytestmark = pytest.mark.requirements("PR-13", "PR-29")
```

Per-test is also fine:

```python
@pytest.mark.requirements("PR-25")
def test_junit_tag_extraction():
    ...
```

The [`traceability.pytest_requirements`](../tools/traceability/traceability/pytest_requirements.py)
plugin turns each marker into a jUnit tag on that test case:

```xml
<testcase name="test_junit_tag_extraction" ...>
  <properties>
    <property name="requirement" value="PR-25"/>
  </properties>
</testcase>
```

Python suites route their `pytest_main.py` through the shared runner
([`traceability.pytest_runner`](../tools/traceability/traceability/pytest_runner.py)),
which registers the plugin and writes jUnit to `$XML_OUTPUT_FILE` — the file
Bazel captures under `bazel-testlogs/<pkg>/<name>/test.xml`. So every
traceability-enabled `py_test` carries its tags into CI with no extra flags:

```python
from traceability.pytest_runner import main

if __name__ == "__main__":
    raise SystemExit(main(__file__))
```

Add `//tools/traceability` to the `py_test`'s `deps` for the import to resolve.

## Verification method (demanded rigor)

A passing test is not automatically enough. Each PR declares the **rigor its
verification demands** via a `method`, drawn from an ordered scale (lowest →
highest) plus one non-ordered value:

```text
analysis  <  simulation  <  sil  <  hil  <  hitl        inspection (unordered)
```

- `analysis` — hand/derivation/static argument. `simulation` — host unit/sim
  test. `sil` — software-in-the-loop (e.g. cross-language conformance).
  `hil` — hardware-in-the-loop component test. `hitl` — full hardware-in-the-loop
  system run. `inspection` — manual/visual sign-off (incomparable: met only by
  inspection evidence).

Evidence carries the rigor it **provides**. Per-testcase, that's a `level=` on
the marker; for whole targets, a `{target, level}` mapping in `verified_by`:

```python
pytestmark = pytest.mark.requirements("PR-29", level="hitl")  # this suite runs on hardware
```

```yaml
- id: PR-13
  method: hitl # demanded rigor
  verified_by:
    - '//web:improv_provision_test' # bare string -> provides simulation
    - { target: '//pi/hitl/tests:e2e_test', level: hitl } # provides hitl
```

The aggregator compares the two, per PR:

- **GREEN (`VERIFIED`)** — a passing artifact provides rigor **≥** the demand.
- **AMBER (`UNDER-VERIFIED`)** — there is passing evidence, but the best rigor
  provided is **below** the demand (e.g. a `hitl` PR covered only by a `simulation`
  test). The row shows _demanded vs best-provided_.
- **RED (`FAILED`) / `UNVERIFIED`** — a test failed / no passing evidence at all.

Migration defaults keep this additive: a PR with no `method` demands `simulation`
and untagged evidence provides `simulation`, so nothing mass-fails. Only the
hardware-implicated PRs (modules touching `firmware`/`pi/hitl`, and derived PRs
mitigating hardware/stability risks) are annotated with their true `hil`/`hitl`
demand — which is why several of those now read AMBER: real verification debt made
visible, not a regression. The HITL `JUnitWriter` stamps its phases `level: hitl`
by default.

## Cost-pyramid policy

Physical test cycles are the scarce, expensive oracle. Cheap verification
(analysis, host simulation) should be **exhausted before** an expensive rung is
accepted as the _sole_ evidence — both to avoid waste and to catch cases where a
physical result was never sanity-checked cheaply. The aggregator enforces this:

> Every PR that demands `hil` or `hitl` and has passing evidence must also carry
> at least one passing artifact at `analysis`/`simulation` level.

A PR whose only passing evidence is the expensive rung is a **policy violation**,
listed in a banner at the top of the report and on stderr. Severity is
configurable via `--pyramid-policy {off,warn,error}` (default `warn`; `error`
fails the aggregate step). An `UNVERIFIED` PR is not a violation — it simply has
no evidence yet.

## Evidence freshness (staleness)

"Was ever green" and "is green for what's on the bench now" are different claims.
A `verified_by` HITL result from three firmware builds ago still reads green as
long as the target name is unchanged — so on-hardware evidence records the
**identity of the artifact it exercised** and the aggregator checks it against
the current build.

The HITL `JUnitWriter` stamps each case with `artifact.<key>` property tags
(firmware build id, board revision, DUT image git SHA). The aggregate step is
told the current identity with repeatable `--current-build KEY=VALUE`:

```sh
bazel run //tools/traceability:aggregate -- aggregate \
  --current-build dut_git_sha="$GIT_COMMIT" \
  --current-build firmware_build_id="$FW_ID" ...
```

Evidence whose recorded identity differs from the current build (on any shared
key) is **STALE**. A PR whose _only_ passing evidence is stale renders AMBER with
a `STALE` badge, not GREEN; fresh evidence, if any, wins. Evidence with no
identity, or when no `--current-build` is given, is never stale — so software
suites are unaffected.

## Risks: severity, likelihood, residual

Mitigation is not elimination. A risk carries `severity` (`low`/`medium`/`high`/
`critical`), an optional ordinal `likelihood`
(`rare`/`unlikely`/`possible`/`likely`/`certain`), and an optional `residual`
note describing what remains after mitigation. The report shows likelihood and
residual on each risk row, and — crucially — hoists any **high/critical-severity
risk whose mitigating derived PR(s) are not GREEN** into a red banner at the top,
distinct from ordinary `UNVERIFIED` rows. A high risk mitigated only by an
under-verified PR is a headline, not a checkmark.

## The work queue (closing the authoring loop)

The report is also a machine-readable queue so its gaps feed back as typed work.
With `--queue-out`, the aggregator writes `traceability-queue.json`: one entry per
`UNVERIFIED` / `UNDER-VERIFIED` / `STALE` PR, with the demanded method, best
provided level, and a **route** derived from the demanded method:

```json
{
  "queue": [
    {
      "pr": "PR-2",
      "gap": "unverified",
      "demanded_method": "simulation",
      "provided_level": null,
      "route": "autonomous"
    },
    {
      "pr": "PR-13",
      "gap": "under-verified",
      "demanded_method": "hitl",
      "provided_level": "simulation",
      "route": "human-gate"
    }
  ]
}
```

- `route: autonomous` — demanded ≤ `sil`; an agent may write the missing
  sim/unit/SIL test itself.
- `route: human-gate` — demanded ≥ `hil` (or `inspection`); the work needs a
  bench/DUT or a human. The agent must **not** synthesise or claim this evidence —
  it may only prepare the harness and open the gate. This encodes the ODD
  boundary: autonomous where cheap verification is trustworthy, a hard checkpoint
  where it isn't.

## Two traceability mechanisms

Verification evidence for a PR is the union of:

1. **Per-testcase tags** (preferred) — the `<property name="requirement">` tags
   above, giving test-case-level traceability. Used by all Python suites,
   including HITL.
2. **Per-target `verified_by`** — a PR may list Bazel test _target_ labels in
   `verified_by`. Every `bazel test` writes a `bazel-testlogs/<pkg>/<name>/test.xml`
   whose path maps back to its target, so the _whole target's_ pass/fail
   contributes to those PRs. This is how C++, Rust, Go and TypeScript suites
   trace today, without per-case tags.

### Extending per-case tags to other languages

The mechanism is language-agnostic: a test runner writes jUnit to
`$XML_OUTPUT_FILE` with a `<property name="requirement" value="PR-…"/>` inside
each `<testcase>`'s `<properties>`. To upgrade a suite from coarse to per-case
traceability, have its runner (or a small jUnit post-processor) emit those tags —
e.g. Go via `go test -json` → a jUnit converter that injects properties from a
`// requirements: PR-…` comment; TS/`node:test` via a reporter that reads a
`requirements` annotation. The aggregator already reads the tags; nothing else
changes.

## The report

The final workflow action aggregates every jUnit XML into a single HTML report:

```sh
bazel run //tools/traceability:aggregate -- \
  --requirements requirements/requirements.yaml \
  --junit "$(readlink -f bazel-testlogs)" \
  --out traceability-report.html
```

In CI this is the `traceability-report` job in
[`.github/workflows/test.yaml`](../.github/workflows/test.yaml): it runs the
suites, aggregates their jUnit, and uploads `traceability-report.html` as an
artifact. The report lists all user needs, product requirements and risks with a
status badge each:

| Status           | Applies to     | Meaning                                               |
| ---------------- | -------------- | ----------------------------------------------------- |
| `VERIFIED`       | PR             | passing evidence provides rigor ≥ demanded            |
| `UNDER-VERIFIED` | PR             | passing, but best provided rigor < demanded           |
| `STALE`          | PR             | only passing evidence is against an out-of-date build |
| `FAILED`         | PR / UN / RISK | a referencing/rolled-up test failed or errored        |
| `UNVERIFIED`     | PR             | no passing test references it                         |
| `VALIDATED`      | UN             | all satisfying PRs verified                           |
| `PARTIAL`        | UN / RISK      | some rolled-up PRs verified or only under-verified    |
| `MITIGATED`      | RISK           | all mitigating derived PRs verified                   |
| `OPEN`           | RISK           | no mitigating PR verified                             |

## Recipes

- **Add a requirement:** add a `PR-…` entry (with `satisfies`, and `modules`);
  document it in the implementing module's `BUILD`; annotate its tests. Run
  `bazel test //requirements:requirements_valid_test` and
  `bazel run //requirements:check_annotations`.
- **Add a risk + mitigation:** add the `RISK-…` with `mitigated_by: [PR-…]` and
  a `kind: derived` PR whose `mitigates` names the risk back; annotate the tests
  that verify the mitigation.
- **Find gaps:** open the report — `UNVERIFIED` PRs and `OPEN` risks are the
  work list.
