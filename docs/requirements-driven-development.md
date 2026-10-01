# Requirements-driven development

This repo practises **requirements-driven development (RDD)**: every requirement
is written down in a machine-readable model, modules annotate the requirements
they implement, tests declare the requirements they verify, and CI aggregates
the test results into a report that shows, for the whole model, whether each
user need is **validated**, each requirement **verified** and each risk
**controlled** (FUG-88, FUG-89).

The tooling is [rules_requirements](https://github.com/Studio-Fug/rules_requirements)
([documentation](https://studio-fug.github.io/rules_requirements/)), a
standalone Bazel ruleset extracted from this repo. This page covers how splanc
uses it; the rules_requirements docs cover the model, verdicts and tools in
depth.

## The model

The source of truth is [`requirements/requirements.yaml`](../requirements/requirements.yaml):

| Kind                | Prefix  | Meaning                                                          | Status question                         |
| ------------------- | ------- | ---------------------------------------------------------------- | --------------------------------------- |
| User need           | `UN-`   | What a user must be able to do.                                  | **Validated?** (rolls up its PRs)       |
| Product requirement | `PR-`   | A verifiable requirement; `satisfies` user needs.                | **Verified?** (its tests, at its rigor) |
| Risk                | `RISK-` | A failure mode, with `severity`, `likelihood`, `residual`.       | **Mitigated?** (rolls up mitigations)   |
| Mitigation          | `MIT-`  | A risk control measure: `mitigates` risks, `implemented_by` PRs. | **Verified?** (rolls up its PRs)        |

FUG-88 stated each risk's mitigation as prose; each is captured as a
mitigation `MIT-n` (for `RISK-n`) implemented by a `category: risk-control`
product requirement (PR-26..37) that tests verify like any other PR. The
`config:` section keeps splanc's `PR-` prefix for requirements.

```yaml
requirements:
  - id: PR-34
    title: Pin the wire schema with cross-language conformance tests
    category: risk-control
    satisfies: [UN-3, UN-4, UN-6, UN-7]
    modules: [shared/protocol, pi/server, pi/reconstruction, web, solver]
    verified_by: ['//web:proto_test'] # coarse, per-target traceability
mitigations:
  - id: MIT-9
    title: Pin the wire schema with cross-language conformance tests
    mitigates: [RISK-9]
    implemented_by: [PR-34]
```

`bazel test //requirements:model_test` fails on any malformed entity, bad id,
dangling reference, orphaned requirement, unsatisfied need or uncontrolled
risk. It is also the evidence for PR-23 and PR-25 (the model and its coverage
gate), which cite it in `verified_by`.

## Annotating code and tests

Each module's `BUILD.bazel` docstring names the PRs it implements with an
`@rr(...)` annotation:

```python
"""pi/led_driver — SK9822/APA102 Gray-code pattern driver.

@rr(PR-11): implemented in this package (see requirements/requirements.yaml)
"""
```

Python tests declare what they verify with a marker (module-wide via
`pytestmark`, or per test), optionally with the rigor they provide:

```python
pytestmark = pytest.mark.requirements("PR-13", "PR-29", level="hitl")
```

`@pytest.mark.rr(...)` is the same marker under its rules_requirements name.
Each package's `tests/pytest_main.py` delegates to
`rules_requirements.hooks.pytest_runner`, which writes JUnit to
`$XML_OUTPUT_FILE` with one `<property name="requirement">` per id; add
`@rules_requirements//python` to the `py_test`'s `deps`.

The on-hardware harness ([`pi/hitl/harness/hitl_e2e.py`](../pi/hitl/harness/hitl_e2e.py))
records each phase with `rules_requirements.hooks.junit_writer.JUnitWriter`
(level `hitl`; the phases and the PRs each verifies are in
[`e2e_phases.py`](../pi/hitl/harness/e2e_phases.py)), stamping the firmware
bundle (name and content hash) / DUT git SHA / board so stale evidence is
detectable. A PR reads VERIFIED from a HITL run only if every phase of that run
that verifies it passed. A device failure (a phase's check, no device URL after
provisioning, the DUT unreachable from the rig) fails the PRs of the failing
phase, or, when the run stops between phases, of every planned phase that never
ran (`incomplete_run`). Rig or setup trouble (reservation, ssh/scp transport,
no WiFi credentials, an interrupt) fails no PR: it is recorded untagged, so it
shows up as an untraced failure.

`bazel run //requirements:check_annotations` scans the tree and fails on any
annotation naming an id that does not exist.

## Verification rigor, staleness, cost pyramid, work queue

A passing test is not automatically enough: each PR's `method` names the rigor
its verification demands (`analysis < simulation < sil < hil < hitl`, plus
`inspection`; default `simulation`) and evidence carries the rigor it provides.
Hardware PRs covered only by simulation read **UNDER-VERIFIED** — real
verification debt made visible. Evidence recorded against a different
`--current-build` identity is **STALE**; a `hil`/`hitl` PR whose only evidence is
physical violates the **cost pyramid**; and every gap lands in a machine-readable
**work queue** routed `autonomous` (≤ `sil`: an agent can close it) or
`human-gate` (needs a bench or a person). See
[Concepts](https://studio-fug.github.io/rules_requirements/concepts.html) in the
rules_requirements docs for the exact semantics.

Two traceability mechanisms feed each PR's evidence: per-testcase properties
(preferred; all Python suites, including HITL) and per-target `verified_by`
labels (a whole Bazel test target's pass/fail — how the C++, Rust, Go and
TypeScript suites trace today; googletest and Rust can move to per-case tags
with `RR_VERIFIES(...)` / `rr::verifies!(...)`).

## The report

CI's `traceability-report` job in [`.github/workflows/test.yaml`](../.github/workflows/test.yaml)
runs the suites, then:

```sh
bazel run @rules_requirements//python:rr -- report \
  --model requirements \
  --evidence "$(readlink -f bazel-testlogs)" \
  --current-build dut_git_sha="$GITHUB_SHA" \
  --scan --root . \
  --queue-out traceability-queue.json \
  --json traceability-report.json --md traceability-report.md \
  --html traceability-report.html
```

The HTML, JSON, Markdown (also added to the job summary) and queue are uploaded
as the `traceability-report` artifact.

HITL tests only run where the rigs are reachable, so the HITL workflow
([`.github/workflows/hitl.yaml`](../.github/workflows/hitl.yaml)) publishes its
own `hitl-traceability-report` from the on-hardware run: each harness phase is a
case tagged with the PRs it verifies at level `hitl` and stamped with the
firmware bundle and DUT commit (`GITHUB_SHA`), and only each test's final
attempt counts (a `--flaky_test_attempts` retry that passed is what gated).
Read the two reports together: the software report carries the
simulation-level evidence and the HITL report the `hitl`-level evidence, so a
PR that is UNDER-VERIFIED in one can be VERIFIED by the other. HITL harness
targets other than the e2e phases (fx_bench, led_capture, video_stream, ...)
are not tagged with PRs; their failures appear as untraced failures.

## Editing the model in the browser

```sh
bazel run //requirements:editor   # then open http://localhost:8080/
```

opens the rules_requirements [web editor](https://studio-fug.github.io/rules_requirements/guides/web-editor.html)
on `requirements/requirements.yaml`, reading test evidence from `bazel-testlogs`:

- **Author and edit** needs, PRs, risks and mitigations in forms; edits are
  small, comment-preserving YAML changes, verified before anything is written,
  so they review like hand edits.
- **Trace** each item both ways, on a graph coloured by verification status,
  down to the `@rr(...)` annotations and tests that implement and verify it.
- **Version**: diff the model between branches, tags and commits, tag
  baselines, and commit model changes (only the model files).
- **Review with agents**: a deterministic completeness check (untraced PRs,
  unverified or under-verified PRs, uncontrolled risks, stale evidence), and
  Claude-backed reviews — does a test really prove its PR, does a PR really
  enforce its mitigation, which hazards are missing. Findings become notes on
  the model (`kind: gap` / `todo` / `question`) or new entities, ready to drive
  the next implementation cycle. The Claude-backed reviews use the `anthropic`
  SDK from splanc's Python lock, with Claude credentials from the environment
  you `bazel run` the editor in: `ANTHROPIC_API_KEY`, or an `ant auth login`
  profile. Without credentials the deterministic completeness check still
  works (the Claude-backed reviews fail with an authentication error).

It binds to localhost only and edits your checkout.

## Recipes

- **Add a requirement:** add a `PR-…` entry (with `satisfies` and `modules`),
  add it to the implementing module's `@rr(...)` line, and mark its tests. Run
  `bazel test //requirements:model_test` and
  `bazel run //requirements:check_annotations`.
- **Add a risk + mitigation:** add the `RISK-…`, a `MIT-…` that `mitigates` it
  and is `implemented_by` a `category: risk-control` PR, and mark the tests that
  verify that PR.
- **Find gaps:** open the report (or `traceability-queue.json`) —
  `UNVERIFIED`/`UNDER-VERIFIED` PRs and `OPEN` risks are the work list.
