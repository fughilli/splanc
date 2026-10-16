# FUG-89: Case Ledger v2 (one test case, one requirement): design

> This design predates the implementation. Where they differ, rules_requirements' [release notes](https://studio-fug.github.io/rules_requirements/release-notes.html) and [migration guide](https://studio-fug.github.io/rules_requirements/guides/migrating-to-per-case.html) are authoritative, and splanc PR #242's per-case owners override Part C. Handoff: splanc issue #244.

## name

Case Ledger v2: model-owned per-case attribution with fail-closed quarantine and locked verification sets

## summary

Case Ledger v2 makes "a test case counts toward at most one requirement" a property of how attribution is represented in rules_requirements. It is not a convention that tests or authors have to follow.

THE GUARANTEE
- One function decides ownership. `attribution.attribute(model, evidence, lock)` builds `owner: dict[CaseKey, entity_id]`. It is the only code that gives a test case a requirement.
- A dict cannot map one key to two values, so no case can have two owners.
- Every verdict, rollup, report row, editor panel and agent prompt reads its members from the resulting `Attribution`.
- Evidence never stores an owner: `TestCase.declared` is plain data, and `build_matrix` always recomputes attribution. There is no stored owner anywhere to bypass.

THE MODEL DECIDES (end state: `attribution: model`)
- `verified_by` items become case selectors: either `{target, cases: [literal | '*'-glob, ...]}`, or `{target, whole: true, reason}` for targets that only produce Bazel's single synthetic result.
- User needs (`validated_by`) and mitigations (`verified_by`) share the same claim namespace.
- Claims made by different entities must be disjoint. For the `*`-only selector grammar there is an exact overlap witness (prototyped and cross-checked against brute force).
- That witness makes `shared-case` a static error that cannot be configured off. It is raised by `rr validate`, `//requirements:model_test`, the editor's save guard and `rr report`.

TAGS ARE SINGLE-ID CROSS-CHECKS
- Tags come from pytest markers, `rr.verifies`, JUnitWriter, `RR_VERIFIES`, `rr::verifies!`, node diagnostics, records and `[rr:ID]` name tags.
- Each can carry exactly one id per case. A multi-id tag is a deprecation in 0.2/0.3 and a compile, import or collection error in 0.4.
- In model mode a tag only raises `tag-mismatch` or `unclaimed-tag`.
- In the transitional hybrid mode, a single tag may own a case that no claim covers.
- Neither mode can produce a second owner.

FAIL CLOSED
A case is quarantined if any of these hold:
- its evidence names two ids;
- two claims select its key;
- the same test code (same source file and case path, or a declared variant target) is owned by two requirements.

A quarantined case counts for nobody. Every entity it names reads INVALID (which rolls up like FAILED), and `rr report` exits 3.

VERIFICATION SETS
- A requirement's set is the cases it owns plus the cases it is expected to own. Expected cases come from literal selectors and from `verification.rrlock`, a generated case→one-id lock that pins the expansion of globs, whole-target claims and tag ownership.
- VERIFIED only when every member is present, passed, not retry-masked (a retry-masked pass is UNDER-VERIFIED by default) and fresh against `--current-build`, and the best member level meets the demand.
- INCOMPLETE when any member is missing, not run or skipped.
- FAILED when any member fails, or the target has a target-level taint: a crash, a non-zero exit after passing cases, a load error, or a failing root hook.
- INVALID on quarantine.
- Lanes never soften a verdict. Only the combined software + HITL report can read VERIFIED for a set that spans both lanes.

PER-CASE EVIDENCE EVERYWHERE
- `rr_node_test` (a node:test reporter plus runner) turns splanc's 77 one-case web targets into about 524 cases. It was prototyped end to end on Node 22.22.0, the toolchain of aspect_rules_js 3.2.2.
- `rr_rust_test` covers the 4 libtest targets.
- A header-only `rr_case.h` runs each case in its own forked child, with no googletest, and covers the 3 plain-assert firmware tests.
- `CheckPlan` turns HITL phases into unowned steps plus single-owner checks.

AUDIT AND TOOLING
- `rr check-report` re-proves the partition from the published JSON alone.
- Supporting commands: `rr attribution`, `rr cases`, `rr sets lock|check`, `rr migrate plan|apply`.

NO BIG BANG
- **v0.2.0 is additive:** runners, CheckPlan, the attribution worksheet and a tag-split codemod, with no verdict changes. splanc can land all granularity work on today's semantics with CI green.
- **v0.3.0 changes semantics** (hybrid is the default). Its pin-bump PR only has to turn the 6 shared web targets into case selectors; //requirements:model_test is fixed earlier.
- **`rr migrate apply --stage model`** then moves splanc to model mode with a lock. It is mechanical and keeps the case→owner table unchanged.
- **v0.4.0** makes multi-id authoring impossible.

SCALE
Recomputed from the latest main reports at design time:
- In the software report, 178 of 271 attributed evidence units count toward two or more requirements: 171 pytest cases from 13 multi-id modules, plus 7 whole targets shared by 2–3 PRs.
- In the HITL report, 3 of 3 phase cases do.
- After migration the count is 0 by construction.

PROTOTYPES (written during the design work; the implementations in rules_requirements v0.2.0–v0.3.0 superseded them)
- **case_selectors.py:** the witness DP, cross-checked on 20k pattern pairs against brute force.
- **attribution_proto.py:** a 10k-trial fuzz of the owner invariant, quarantine→INVALID, the lock and hybrid mode. It also asserts that every report-time conflict has a static witness.
- **rr_node_reporter.mjs + node_test_main.cjs:** verified on Node 22.22.0 for nesting, subtests, skip/todo, duplicates, diagnostics, late unhandled rejection, load error, and a failing root after-hook (Bazel passes that one; we taint it).
- **rr_case.h:** a failing assert or a segfault is isolated to its own case; core dumps are suppressed.

## model_changes

1. AUTHORED SHAPES (requirements.yaml)
```yaml
config:
  prefixes: {requirement: PR}
  attribution: model            # hybrid | model. Default: hybrid in 0.3, model in 0.4. Neither allows two owners.
  main_repo: splanc             # '@splanc//x:y' means '//x:y'
  sets_lock: verification.rrlock   # relative to this file; pins every set's membership
  flaky: under-verify           # accept | flag | under-verify (default) | fail
  set_consistency: warn         # off | warn (default) | enforce  (members stamped with different builds)
  variants:                     # targets that run the same test code under another configuration
    - [//pi/hitl/harness:fx_bench_netstack, //pi/hitl/harness:fx_bench_jit_netstack]
    - [//pi/hitl/harness:led_capture_netstack, //pi/hitl/harness:led_capture_jit_netstack]
  rules: {whole-target-reference: error, bare-target-reference: error}
requirements:
  - id: PR-29
    method: hitl
    verified_by:
      - target: //web:improv_provision_test
        cases: ["improv_provision::provisionViaBle: survives Android's first-attempt GATT flake via retry"]
      - target: //pi/hitl/tests:hitl_test
        cases: ["pi.hitl.tests.test_improv::test_retry_*"]       # '*' is the only wildcard
      - target: //pi/hitl/harness:e2e_netstack
        level: hitl                                               # applies only to cases declaring no level
        cases: [hitl_e2e.improv_provision::readiness_retry]
  - id: PR-25
    verified_by:
      - {target: //requirements:model_test, whole: true, reason: "rr validate runs as one test"}
user_needs:
  - {id: UN-5, validated_by: [{target: "record:usability_study", cases: ["*"]}]}   # new; same claim namespace
mitigations:
  - {id: MIT-4, verified_by: [...]}                                                  # new; effectiveness evidence
```

Item rules:
- An item is a mapping with `target` and exactly one of `cases` (a non-empty list of selectors) or `whole: true`. `level` and `reason` are optional. Any other key goes to the existing `unknown-field` rule.
- `cases: ["*"]` means every per-case result of the target. It is preferred whenever the target reports per-case results, because members are then enumerated and locked.
- `whole: true` means the same thing, except that when the target produced no per-case result it means its single synthetic result (case path `[target]`).
- Legacy forms still parse: a bare label, `{target}` or `{target, level}`. They become `whole: true, legacy: true` and raise rule `bare-target-reference`.
- Legacy forms are never grandfathered when two entities share a target. That is `shared-case`.

2. DATACLASSES (model.py)
```python
@dataclass(frozen=True)
class VerifiedBy:
    target: str                     # normalized (labels.normalize_label); original spelling kept for edit.py round-trips
    cases: tuple[str, ...] = ()     # selectors; () iff whole
    whole: bool = False
    level: str = ""
    reason: str = ""
    legacy: bool = False            # authored as bare label / {target[, level]}
    extra: tuple[tuple[str, Any], ...] = ()

@dataclass(frozen=True)
class Claim:                         # one selector of one entity
    entity: str; kind: str; target: str
    pattern: str | None             # None == whole target
    literal: bool                   # no unescaped '*'
    level: str; index: int; location: Location

UserNeed.validated_by: tuple[VerifiedBy, ...] = ()
Mitigation.verified_by: tuple[VerifiedBy, ...] = ()
Model.claims(self) -> list[Claim]   # every claim of every entity, stable order
```
- FIELDS: user_need gains `validated_by`; mitigation gains `verified_by`.
- Risks and test methods still reject both keys (`unknown-field` is an error by default). A tag that names a RISK or TM id stays `misdirected-evidence` and owns nothing.

3. LABELS (new labels.py)
`normalize_label(label, main_repo="") -> str`, which raises `BadTarget`:
- `@@//p:n`, `@//p:n` and `@<main_repo>//p:n` become `//p:n`. `//p` becomes `//p:p`.
- Canonical module-repo decorations are dropped. `@@rules_requirements+//p:n` (Bazel 8) and `@@rules_requirements~//p:n` (Bazel 7: splanc pins 7.7.1, rules_requirements 8.8.1) both become `@rules_requirements//p:n`. A model can therefore use apparent names while testlogs' `external/<repo>~/` paths still match.
- Pseudo-targets pass through unchanged: `suite:<testsuite name>` (JUnit outside a testlogs tree) and `record:<stem>` (records without a target).
- Anything else (`:n`, `p:n`, empty) is a `bad-target` error.
- Normalization is applied when the model is parsed, and again to every evidence target (`target_from_path`, wrap `--target`, records).

4. SELECTORS (new case_selectors.py)
The name avoids `selectors.py`, which would shadow the stdlib module that subprocess and asyncio import whenever the package directory itself is on sys.path.

Grammar:
- A selector matches the whole canonical case path (case_identity), case-sensitively.
- `*` matches any string, including the empty string, `::`, `/` and spaces. `**` is the same as `*`.
- `\*` and `\\` are escapes. Any other backslash is `bad-selector`.
- `?`, `[` and `]` are literals, because pytest ids such as `test_x[exc0-False]` contain them. This is unlike fnmatch, where `test_x[*]` does not match `test_x[a]`.
- Selectors never match synthetic or target-scope results.

API:
- `tokens(p)`, `is_literal(p)`, `matches(p, path)`
- `witness(p, q) -> str | None`: a memoised O(|p|·|q|) DP that returns a string matching both patterns, or None if they are disjoint. It is exact for this grammar.

The design-time prototype passed 20k random pairs, over an alphabet with `[` and `:`, against brute force.

5. CONFIG (config.py)
`parse_config` accepts six new keys: `attribution`, `main_repo`, `sets_lock`, `flaky`, `set_consistency`, `variants`. Older releases reject them as an unknown key, so a 0.3 model fails loudly on 0.2.

Configurable rules added to DEFAULT_RULES (default in 0.3 → default in 0.4):

| Rule | What it flags | Default |
|---|---|---|
| `bare-target-reference` | a legacy-form claim | warning → error |
| `whole-target-reference` | `whole` without `reason` | warning |
| `coarse-claim` | `whole` on a target that reports per-case results | warning |
| `glob-selector` | any glob selector | off |
| `redundant-selector` | one entity's selectors overlap | warning |
| `tag-mismatch` | a tag disagrees with the model's owner | warning |
| `unclaimed-tag` | model mode: a single-id tag on a case no claim covers | warning |
| `suite-level-requirement` | a suite-level requirement property | warning |
| `duplicate-case` | the same key twice in one run | warning |
| `level-mismatch` | the case's level differs from the selector's level | warning |
| `same-path-multiple-owners` | equal paths in different targets with different owners, source file unknown | warning |
| `parent-with-claims` | a requirement with refining children also claims cases | warning |
| `multi-verifies-annotation` | rr scan finds a verifies annotation with several ids | warning → error |
| `lock-stale` | a lock entry that no claim of its owner matches | error |

Hard errors are deliberately left out of DEFAULT_RULES, so configuring them, for example `rules: {shared-case: off}`, is itself a config error:
- `shared-case`
- `same-code-multiple-owners` (static, through `variants`)
- `bad-selector`
- `bad-target`
- `lock-owner-changed`
- `lock-invalid`
- `unknown-target` (only with `--known-targets`)

Report-time quarantine codes (`multi-tag`, `attribution-conflict`, `same-code-multiple-owners`) are not rules at all. `--strict` only escalates warnings.

6. VALIDATION (validate.py: new check_claims() and check_lock())
- Claims are grouped by normalized target. Every pair from different entities is an error if either side is whole, or if `witness(p, q)` is not None. The message carries both ids, both patterns, a witness and both locations:

  `requirements.yaml:411: error: [shared-case] PR-29 and PR-13 both claim cases of //web:clocksync_test ('clocksync::*' vs 'clocksync::offset*'), e.g. 'clocksync::offset'. A test case verifies at most one requirement: narrow one selector.`
- The same pairwise check across the targets of one `variants` group raises `same-code-multiple-owners`.
- Other checks:
  - an overlap within one entity → `redundant-selector`;
  - empty `cases`, both `cases` and `whole`, a padded or empty pattern, or a bad escape → `bad-selector`;
  - a bad label → `bad-target`;
  - claim levels → the existing `bad-level`.
- `rr validate --known-targets FILE` (FILE is `bazel query 'tests(//...)'` output) raises `unknown-target` for a claim on a label that does not exist. Without it, a typo would read as not-run forever. Pseudo-targets are exempt.
- When `sets_lock` is configured:
  - the lock must exist and parse (`lock-invalid`);
  - every entry's owner must be a verifiable entity;
  - in model mode, an entry matched by no claim of its owner is `lock-stale`, and an entry matched by another entity's claim is `lock-owner-changed`.
- Cost is O(Σ k²·|p|·|q|), which is trivial at splanc's size (about 45 targets, a few selectors each).

7. LOCK (new lock.py; schema/verification_lock.schema.json)
```yaml
# Generated by `rr sets lock --write`; review its diff like a golden file.
schema: rules_requirements/verification-lock/v1
cases:
  //web:improv_provision_test:
    "improv_provision::provisionViaBle: sends the correct wifi-settings wire and returns the redirect": PR-13
    "improv_provision::provisionViaBle: survives Android's first-attempt GATT flake via retry": PR-29
  //requirements:model_test:
    "[target]": PR-25
```
- Each case key maps to one scalar id. A list value, or a duplicate key (rejected by the model loader's duplicate-key check), is `lock-invalid`. The file cannot express two owners.
- `.rrlock` is not one of the extensions `model_files()` reads (.yaml/.yml/.json). splanc passes the whole requirements/ directory as `--model`, so this keeps the lock out of the model.
- The lock never creates ownership. It only adds expected members (see set_semantics).

8. RECORDS (*.rr.yaml)
- An optional document-level `target:` can be set, and items may override it. The default target is `record:<file stem>`.
- `requirement: REQ-7` is a scalar tag. The legacy `requirements: [one]` is still accepted; a longer list is `multi-tag`.
- examples/thermostat/evidence/panel_inspection.rr.yaml migrates to `target: record:panel_inspection` with a scalar `requirement`.

9. JSON SCHEMA (schema/rules_requirements.schema.json)
- `$defs/verifiedBy` is `oneOf`:
  - a string, described as "DEPRECATED: whole target";
  - an object with `additionalProperties: false`, `required: [target]`, and these properties:
    - `target`: pattern `^((@@?[^/]*)?//[^:]*(:.+)?|suite:.+|record:.+)$`
    - `cases`: array of string, minItems 1
    - `whole`: const true
    - `level`, `reason`: string
    - exactly one of `cases` or `whole` required.
- The definition is reused by `requirements[].verified_by`, `user_needs[].validated_by` and `mitigations[].verified_by`. The config section gains the six new keys.
- New schemas: verification_lock, report.v2, attribution worksheet (`.rrplan`).

10. FILE-LEVEL CHANGE LIST (rules_requirements)

New files:
- labels.py, case_selectors.py, attribution.py, lock.py, migrate.py, checkreport.py
- hooks/checkplan.py
- js/{rr_node_reporter.mjs, node_test_main.cjs.tpl, verifies.cjs, BUILD.bazel}
- rr/private/node.bzl
- cc/rr_case.h with `//cc:case`
- schema/{verification_lock,report.v2,worksheet}.schema.json
- docs/guides/migrating-to-per-case.md

Changed files:
- model.py, config.py, validate.py, edit.py
- ingest/{__init__,junit,libtest,records}.py
- trace.py, report/{__init__,html}.py, cli.py
- bazel.py: the exit-status case at :89-101 loses its ids
- hooks/{pytest_plugin,unittest,junit_writer,wrap}.py, rr.py, annotations.py
- cc/rr_gtest.h, rust/src/lib.rs
- rr/defs.bzl, rr/private/rules.bzl
- server/{workspace,app}.py, server/static/js/views/{editor,entity,list,overview}.js
- agents/workflows.py: `members_of` replaces `evidence.for_id` at :398; new assign-cases workflow
- graph.py: optional case nodes
- examples/thermostat: model mode, lock, records target; `rr::verifies!("REQ-3", "REQ-4")` in setpoint/src/lib.rs is split
- tests/integration: multi-id tests become quarantine tests
- docs

## authoring_mechanisms

PRINCIPLE
- Every hook writes at most one `requirement` property per case.
- Multi-id authoring is deprecated first: 0.2 and 0.3 warn, and in 0.3 the evidence is quarantined. In 0.4 it becomes impossible, as a compile, import or collection error.
- In model mode a tag never creates ownership; it is a cross-check. In hybrid mode a single-id tag owns a case that no claim covers.

ERROR CODES (printed by hooks, linked from the docs)

| Code | Meaning |
|---|---|
| RR-E101 | One case names more than one id. |
| RR-E102 | A raw `requirement` property bypassed the single-id API. |
| RR-E103 | `RR_VERIFIES` was called outside a running test. |
| RR-E104 | Malformed id: comma, whitespace or empty. |

PYTEST (hooks/pytest_plugin.py)
- `@pytest.mark.rr(id, *, level=None, artifact=None)` (alias `requirements`) takes exactly one positional id.
- Scopes are resolved nearest first, and only the nearest declaration's id is written. Today, ids from every scope accumulate. The order is:
  1. param marks (`pytest.param(..., marks=pytest.mark.rr("PR-34"))`);
  2. function (decorators, conftest `add_marker`, `@rr.verifies`);
  3. class;
  4. module or package `pytestmark`.
- `trace_of(item)` returns `(id | None, level, artifact)`.
- A multi-id declaration (several args, or a comma or whitespace inside one arg):
  - 0.2/0.3: a DeprecationWarning naming the nodeid, and every id is written. In 0.3, ingest then quarantines the case.
  - 0.4: `pytest.UsageError("rr: <nodeid>: marker names PR-13, PR-29; a test case verifies at most one requirement [RR-E101]")`, raised in `pytest_collection_modifyitems`. pytest exits 4 and the Bazel target fails.
- 0.3+: a `pytest_runtest_makereport` hookwrapper removes any `requirement`/`requirements` user_properties the plugin did not write (raw `record_property`) and fails the test with "RR-E102: use @pytest.mark.rr".
- The plugin writes `rr.file`, the test file relative to the workspace (`os.path.relpath(item.path, cwd)` under Bazel), for same-code detection.

UNITTEST / rr.verifies (rr.py, hooks/unittest.py)
- `verifies(id, /, *, level="", artifact=None)`.
- In 0.2/0.3, extra ids or a second stacked decorator with a different id give a DeprecationWarning, and all ids are recorded (quarantined in 0.3).
- In 0.4 the same misuse fails at import: TypeError for an extra positional, or ValueError "rr.verifies: test_x already verifies PR-4 [RR-E101]".
- A method declaration beats a class declaration (nearest wins). Fixture-holder records (setUpClass/setUpModule) and failing-subtest records inherit that single id.
- The hook writes `rr.file`.

JUNITWRITER (hooks/junit_writer.py)
- New signatures: `add(name, requirement: str | None = None, status="passed", message="", duration=0.0, level="", artifact=None, classname="", *, requirements=None)` and `case(name, requirement=None, ...)`.
- A list or tuple passed as `requirement` or `requirements=`:
  - length 0 or 1: accepted with a DeprecationWarning;
  - longer, in 0.2/0.3: DeprecationWarning, then written (quarantined in 0.3);
  - longer, in 0.4: ValueError RR-E101.
- A comma or whitespace inside the string is RR-E104.
- `_Case.requirement: str | None`. In 0.3 the case is frozen and keeps a read-only `requirements` alias.
- `writer.cases` becomes a read-only tuple in 0.3. Code that mutates cases afterwards, as e2e_phases.record_incomplete does today, raises AttributeError instead of silently re-attributing.
- `file` defaults to sys.argv[0] made relative to the workspace, and is written as `rr.file`.
- New `CheckPlan` (see hitl_and_writers).

GOOGLETEST (cc/rr_gtest.h)
- 0.3:
  - The property is renamed `requirement`; ingest also reads `requirements`.
  - Several ids, or a second call with a different id, record a comma list, which is quarantined.
  - `RR_VERIFIES` in SetUpTestSuite, an Environment or main is still recorded, but ingest no longer inherits suite-level requirements (`suite-level-requirement` warning).
- 0.4:
  - `#define RR_VERIFIES(id) ::rules_requirements::Verifies(id)`. The macro has one parameter, so `RR_VERIFIES("A", "B")` is a preprocessor error.
  - `Verifies(const char*)` calls ADD_FAILURE in three cases: a malformed id (RR-E104); a second, different id in the same test ("RR_VERIFIES(B): this test already verifies A [RR-E101]"); no running test (RR-E103).

RUST (rust/src/lib.rs)
- 0.3: trace lines carry a single id, `{"test":…,"requirement":"PR-4"}`. The repetition arm stays, but a line with a list is quarantined, and two calls with different ids produce two lines, which is also quarantined.
- 0.4: the only arms are `verifies!($id:expr)` and `verifies!($id:expr; level = $l:expr)`, so two ids match no arm and fail to compile. `record` keeps a `thread_local!` id and panics "rr::verifies!(B): test already verifies A [RR-E101]" on a different second id.

WRAPPERS
- **hooks/wrap.py:**
  - The `exit-status` case no longer carries the union of traced ids. It is an error case with no ids and `rr.scope=target`, which taints every member claimed on that target.
  - The "no result reported" case (a test that traced, then the binary died) keeps that test's own single id.
  - Traces from spawned threads are dropped with a warning, as today.
  - When nothing is parseable, wrap writes one case with `rr.synthetic=true`.
  - New `--format junit --junit-in PATH` copies a runner's fixed-path JUnit to $XML_OUTPUT_FILE and applies the same exit taint. It is exposed as `rr_wrapped_test(format = "junit", junit_in = ...)`.
- **bazel.py (rr_evidence):** gets the same fix for `test.exit.xml`. Today bazel.py:89-101 calls `w.add("exit-status", list(dict.fromkeys(ids)), ...)`; after the fix the case has no ids and `rr.scope=target`, and the synthetic case for a target without JUnit gets `rr.synthetic=true`.

OTHER PRODUCERS
- **node:test (js/, see typescript_node_test):** an optional `verifies(t, id, level?)` emits `t.diagnostic("rr.requirement=<id>")`. A second, different id throws RR-E101 inside the test. Model mode does not need it.
- **Plain-assert C/C++ (`rr_case.h`):** no tags; the model claims `<suite>::<case>`.
- **Records:** `requirement: REQ-7`; legacy `requirements: [REQ-7]`; a longer list is `multi-tag`.
- **Shell and ad-hoc harnesses:** `rr case --out $XML_OUTPUT_FILE --name "flash ok" --status passed [--classname C] [--requirement PR-21] [--level hitl] [--artifact k=v]` appends one case. `--requirement` is a single argparse value validated as one id.
- **Third-party JUnit producers (Go subtests, Vitest/Jest, Catch2):** `[rr:ID]` anywhere in a case name is read as a declared tag and stripped from the case identity, so re-tagging never renames a case. Two tags, or `[rr:A,B]`, is `multi-tag`.
- **Go (rules_go per-test JUnit)** and any other per-case JUnit producer need no rr code: the model claims `<package>::TestX/subtest`.

SOURCE ANNOTATIONS (annotations.py, `rr scan`)
- A *verifies* annotation naming more than one id raises `multi-verifies-annotation` (warning in 0.3, error in 0.4). Verifies annotations are `@rr(...)` on a test path, `@rr.verifies`, `mark.rr`/`mark.requirements`, `RR_VERIFIES` and `rr::verifies!`. splanc's 13 multi-id `pytestmark` lines are exactly these.
- *Implements* annotations, such as splanc's BUILD-file `@rr(PR-11, PR-34): implemented in this package`, may still list many ids.
- Annotations remain documentation (`verified_in`) and are never evidence.

INGEST (0.3)
- `apply_properties` gathers every requirement value from properties, attributes, records, Rust traces, node diagnostics and name tags.
- It splits on commas and whitespace and stores the distinct ids, in order, in `TestCase.declared`.
- It never assigns an owner.
- Only `level` and `artifact.*` are inherited from suite-level properties.

## enforcement

LAYERS
- **L0, authoring:** single-id hook arity and runtime guards (authoring_mechanisms).
- **L1, static model:** `check_claims` gives an exact `shared-case` witness and the `variants` same-code check; `check_lock` validates the lock.
  - These run in rr validate, `//requirements:model_test`, pre-commit, the editor save guard (409), agent drafts, and `rr report`, which refuses an invalid model with rc 2.
  - None of them can be configured off.
- **L2, ingest:** tags become `declared`, never owners. More than one distinct id makes the case `multi-tag`.
- **L3, attribution:** one function builds the owner map and fails closed.
- **L4, verdicts:** trace.py reads only `Attribution`. The `by_id` loop over `case.requirements` and the `evidence.target_status` reads are deleted from trace.build_matrix/own().
- **L5, gates:** `rr report` exits 3 on any quarantine; `rr sets check`; `rr attribution --check`.
- **L6, audit:** `rr check-report` re-proves the partition from the published JSON alone. Property tests guard the code.

CORE API (attribution.py)
```python
SYNTHETIC_PATH = "[target]"

@dataclass(frozen=True, order=True)
class CaseKey:
    target: str; path: str          # str(): "<target>#<path>"

@dataclass
class CaseResult:
    key: CaseKey; status: str       # passed|failed|error|skipped after merging attempts/runs
    level: str; artifact: dict[str, str]; declared: tuple[str, ...]
    synthetic: bool; flaky: bool; attempts: int; duplicate: bool
    file: str; line: int; sources: tuple[str, ...]; message: str

@dataclass
class TargetRun:
    target: str; ran: bool; synthetic_only: bool
    taint: list[TestCase]           # rr.scope=target errors

MemberState = Literal["passed","failed","error","skipped","missing","not-run","moved","quarantined"]

@dataclass(frozen=True)
class Member:
    entity: str; key: CaseKey | None; selector: str     # pattern | "*whole*" | "lock" | "tag"
    via: Literal["model","tag","lock"]; state: MemberState
    level: str; stale: bool; flaky: bool; result: CaseResult | None

@dataclass(frozen=True)
class Quarantine:
    key: CaseKey
    code: Literal["multi-tag","attribution-conflict","same-code-multiple-owners"]
    entities: tuple[str, ...]; detail: str

@dataclass
class Attribution:
    mode: str
    cases: Mapping[CaseKey, CaseResult]
    owner: Mapping[CaseKey, str]                # THE function
    via: Mapping[CaseKey, str]                  # model | tag
    members: Mapping[str, tuple[Member, ...]]
    quarantined: list[Quarantine]
    targets: Mapping[str, TargetRun]
    issues: list[AttributionIssue]   # tag-mismatch, unclaimed-tag, duplicate-case, unlocked-member,
                                     # lock-owner-changed, suite-level-requirement,
                                     # same-path-multiple-owners, level-mismatch, unscoped-evidence
    def members_of(self, entity: str) -> tuple[Member, ...]: ...
    def check_invariant(self) -> None: ...

def resolve_cases(evidence: Evidence, config: Config) -> tuple[dict[CaseKey, CaseResult], dict[str, TargetRun], list[AttributionIssue]]
def attribute(model: Model, evidence: Evidence, *, current_build=None, lock: Lock | None = None) -> Attribution
class AttributionInvariantError(AssertionError)   # raised only by check_invariant: a bug in this module
```

attribute() STEP BY STEP
1. `resolve_cases` merges raw TestCases into one CaseResult per key: the final attempt wins, the worst run wins, shards are unioned, and evidence roots are merged. It also collects target-scope taint per target.
2. For each claim, collect the matched keys:
   - whole: every case-scope result of the target, or its synthetic result if the target has nothing else;
   - pattern: `matches(pattern, key.path)` over non-synthetic case-scope results.
   - Each match sets `claimed_by[key].add(entity)`.
3. For each key, the first matching rule applies:
   - (a) more than one distinct declared id → quarantine `multi-tag`. Its entities are the declared ids that are verifiable model entities, plus the claimants.
   - (b) more than one claimant → quarantine `attribution-conflict`.
   - (c) exactly one claimant E → owner = E, via model. A declared id other than E is `tag-mismatch`.
   - (d) hybrid mode and exactly one declared id X that names a requirement, user need or mitigation → owner = X, via tag.
   - (e) model mode and one declared id → `unclaimed-tag`.
   - (f) a declared RISK/TM id → `misdirected-evidence`; an undefined id → `unknown-id`. Neither owns anything.
4. Same-code check:
   - Owned keys with the same non-empty `file` and the same path, in different targets, with different owners → every one of those keys is quarantined `same-code-multiple-owners`.
   - Owned keys in targets of one `variants` group with equal paths (including `[target]`) and different owners → also quarantined.
   - Equal paths in different targets with different owners where `file` is unknown → rule `same-path-multiple-owners`.
5. Build members per entity (states are defined in set_semantics):
   - owned keys matched by its claims, or tag-owned keys;
   - one pseudo-member per selector that matched nothing: `missing` if the target ran, `not-run` if not, `error` if the target is tainted or its only result is a failed synthetic one;
   - lock entries for the entity: `missing` if the target ran without that key; `not-run` if the target did not run; `moved` (plus `lock-owner-changed`) if the key now has another owner or none;
   - quarantined keys that name the entity: `quarantined`;
   - owned keys absent from a configured lock raise `unlocked-member`.
6. `check_invariant()` asserts all of the following:
   - `owner` is a function;
   - the owned members (states passed/failed/error/skipped) partition the owned keys, so no key appears under two entities;
   - no key is both owned and quarantined;
   - every entity named by a quarantine has a `quarantined` member.

EVERY PATH BY WHICH A CASE COULD ACQUIRE A REQUIREMENT, AND HOW EACH IS CLOSED

| # | Path | How it is closed |
|---|---|---|
| P1 | pytest marker with several ids (splanc: 13 modules) | L0 deprecation, then UsageError; L2 `multi-tag` → quarantine/INVALID. |
| P2 | Markers at several scopes accumulating (today ids are unioned) | Nearest scope wins; one property is written. |
| P3 | Raw `record_property("requirement")` | RR-E102 makereport guard; L2. |
| P4 | Stacked `rr.verifies` / class and method decorators | Nearest wins; 0.4 import error. |
| P5 | JUnitWriter lists: HITL PHASES, the `incomplete_run` case naming every pending PR, `record_incomplete` mutating `case.requirements` | Single-id API, CheckPlan, read-only cases. |
| P6 | RR_VERIFIES variadic, repeated, or at suite level; suite properties inherited by every case (junit `_suite` today) | Single-arg macro, ADD_FAILURE, suite-level requirements no longer inherited. |
| P7 | `rr::verifies!` with several ids or called repeatedly | Single arm plus panic; trace lines become declared → quarantine. |
| P8 | wrap.py `exit-status` case carrying the union of traced ids | No ids; target-scope taint. |
| P9 | bazel.py rr_evidence `test.exit.xml` carrying the same union | Same fix. |
| P10 | node: diagnostics, a non-zero exit after passing cases, load errors, failing root hooks | Diagnostics are cross-checks; the runner adds target-scope taint for the rest. |
| P11 | Any JUnit producer: `requirements="A,B"`, a repeated `<property name=requirement>`, attributes, the plural form | `declared` → `multi-tag`. |
| P12 | Suite-level properties | Not inherited; warning. |
| P13 | Records `requirements: [A, B]` | `multi-tag`. |
| P14 | Third-party ingestors filling `TestCase.requirements` | Now an alias of `declared`; resolved only by `attribute()`. |
| P15 | Two requirements naming the same whole target (splanc: pinhole, clocksync, improv_provision, flashUsb, flashEnv, costModel, model_test) | Static `shared-case`; report-time conflict. |
| P16 | Overlapping patterns | Exact static witness; report-time check. |
| P17 | A whole claim and a pattern claim on one target | Static. |
| P18 | One target spelled differently (`@@//`, `@splanc//`, `//p`, canonical `~`/`+`) | `normalize_label` on both sides; `bad-target`. |
| P19 | Model and tag disagree, or a hybrid tag | Model wins with `tag-mismatch`; hybrid tags only fill unclaimed keys. |
| P20 | Cross-kind: `validated_by` on a UN or `verified_by` on a MIT claiming a requirement's case | One claim namespace. RISK/TM cannot hold claims (`unknown-field`); RISK/TM tags are `misdirected-evidence`. |
| P21 | The same case ingested several times: `test_attempts/attempt_N.xml` plus `test.xml`, `run_k_of_n`, shards, rr_evidence plus testlogs, sw plus hitl roots | `resolve_cases` merges by key → one result → one owner. |
| P22 | Duplicate names in one run | Folded worst-of with `duplicate-case`; still one owner. |
| P23 | Same test code in two targets (fx_bench.py is the main of fx_bench_netstack and fx_bench_jit_netstack; hitl_led_capture.py of led_capture_netstack and led_capture_jit_netstack) | `file` identity → quarantine at report time; `variants` → static error; `same-path-multiple-owners` as a fallback. |
| P24 | refines / satisfies / implemented_by rollups | These propagate verdicts between entities, never cases. Derived verdicts are labelled `basis: derived` with `derived_from`; `parent-with-claims` rule; `check-report` proves the direct partition. |
| P25 | Hand edits to the lock | It maps a case to one id; duplicate keys are rejected; it adds expectations only, never ownership; disagreement is `lock-owner-changed`. |
| P26 | Web editor, agents, hand edits to YAML | Save guard (409), model_test, report validation. Agents only write worksheet proposals. |
| P27 | Source annotations | Documentation only. |
| P28 | Configuration | Hard errors are not rules; `--strict` only escalates; `--on-attribution-error=warn` changes the exit code, never verdicts. |
| P29 | Python API: hand-built `Evidence` or `TestCase(requirements=...)` | Alias of `declared`; `build_matrix` always runs `attribute()`; nothing stores an owner. |
| P30 | A future code path reading tags in trace.py | Field renamed; `Evidence.for_id` deprecated; `check_invariant()` in `build_matrix`; fuzz test. |
| P31 | `agents/workflows.py:398` builds agent context from `evidence.for_id` (raw tags) | Replaced by `Attribution.members_of`. |

ON VIOLATION
- **Hook misuse:** RR-E101–E104. The test or collection fails (0.4), or a deprecation is issued and the evidence is quarantined (0.3).
- **`shared-case` / `same-code-multiple-owners` (static):** a validation error. model_test fails, `rr report` returns rc 2, and an editor save returns 409 naming the conflicting case and its current owner.
- **Quarantine (report time):**
  - The key gets no owner.
  - Every entity it names reads INVALID and gets an `invalid` gap.
  - A per-key gap (`multi-tag`, `attribution-conflict` or `same-code-multiple-owners`, route autonomous) lists each claim's origin. Example:

    `attribution-conflict: //web:clocksync_test#clocksync::bestSample keeps the min-RTT sample is claimed by PR-13 (requirements.yaml:233) and PR-29 (requirements.yaml:411); it verifies neither until it has one owner`
  - stderr prints "ATTRIBUTION ERROR: …".
- **Exit codes for `rr report`:**
  - 0 = OK
  - 1 = the `--fail-on` policy (INVALID counts as failed; INCOMPLETE counts as unverified)
  - 2 = invalid model
  - 3 = any quarantine, unless `--on-attribution-error=warn`. The reports are still written first.
- **Other commands:** `rr sets check` and `rr attribution --check` exit 1 on drift or problems.
- **`rr check-report`** exits 1 if any key appears under two entities, if an owner is not a scalar, if a quarantined key is owned, if a named entity is not INVALID, or if the counts disagree.

WHY IT CANNOT BE BYPASSED
- **Representation:** a scalar owner per key, and sets are its fibres.
- **Single entry:** every mechanism only produces claims or declared tags. Ownership exists only inside `attribute()`, which `build_matrix`, `rr serve`, the agents, `rr migrate` and `rr sets` all call.
- **Fail closed:** ambiguity removes the evidence and visibly marks every entity it touches, so a multi-tag can never be used to cheat.
- **Defence in depth:** errors are caught before evidence exists (L0/L1, editor), and the published artifact is audited independently afterwards (L6).

TESTS (python/tests/test_attribution.py, test_case_selectors.py, test_lock.py, test_checkreport.py)
- One regression test per path, P1–P31.
- A seeded stdlib-random fuzz (10k trials, mirroring the design-time prototypes (not published; superseded by v0.2.0–v0.3.0)) asserts:
  - the invariant;
  - every report-time conflict has a static witness;
  - every entity named by a quarantine is INVALID;
  - `rr check-report` accepts every generated report and rejects a mutated one (a key injected under a second entity).
- An exhaustive witness-versus-brute-force check (20k pairs).

## case_identity

CASE KEY
- `CaseKey(target, path)`. The string form is `<target>#<path>`; the first `#` separates the two parts, and pseudo-target names are sanitized to contain no `#`.
- Selectors only ever match `path` within one `target`.

TARGET
- **From bazel-testlogs:** `target_from_path` followed by `normalize_label`. A new `run_dims_from_path(path) -> (shard, run, attempt)` parses `shard_i_of_n`, `run_k_of_n` and `test_attempts/attempt_N.xml`; `test.xml` is the final attempt.
- **Other sources:**
  - wrap, rr_node_test and rr_evidence use their `--target` / TEST_TARGET;
  - records use `target:`, or `record:<stem>` when absent;
  - JUnit outside a testlogs tree uses `suite:<testsuite name>`, with an `unscoped-evidence` warning because it cannot be pinned to a build target.

PATH
- `<classname>::<name>`, or `<name>` when classname is empty. It is XML-unescaped, Unicode NFC, with leading and trailing whitespace stripped and internal whitespace kept. `[rr:ID]` name tags are removed.
- The string is never split, so names that contain `::` or ` > ` are fine.
- Shapes per framework, with splanc examples:

| Framework | Path shape | Example |
|---|---|---|
| pytest (xunit2) | module::test | `pi.server.tests.test_handler::test_configure_renegotiates_mid_capture` |
| pytest, parametrized | module::test[id] | `pi.server.tests.test_proto_wire::test_client_roundtrip[configure]` |
| unittest | `<module>.<Class>::test_x` | failing subtest: `<module>.<Class>::test_x (i=3)` |
| googletest | `Suite::Test` | value-parametrized: `Inst/Suite::Test/0` |
| libtest via wrap | module path::leaf | `parse::rejects_empty` |
| node:test via rr_node_test | `<file stem>[ > describe…]::<test>` | `improv_provision::provisionViaBle: survives Android's first-attempt GATT flake via retry`; subtests: `probe > parent with subtests::sub a` |
| rr_case.h | `<suite>::<case>` | `improv_codec::wifi_settings_vector` |
| CheckPlan / JUnitWriter | `<suite>.<step>::<check>` | `hitl_e2e.websocket_checks::rename` |
| rules_go | `<pkg>::TestX/sub` | |

SYNTHETIC RESULTS
- When a target writes no JUnit, Bazel's generate-xml.sh writes one. Its fingerprint is a `<testsuite name=N>` holding exactly one `<testcase name=N status="run">` with no classname, whose `<system-out>` starts with "Generated test.log". For splanc's js_test, N is the launcher path `web/flashEnv_test_/flashEnv_test`.
- Our own writers mark synthetic results explicitly with `rr.synthetic=true`: bazel.py, wrap.py, and rr_node_test on an unsupported Node.
- A synthetic result gets path `[target]`, whatever its name. It is a member only of `whole` claims, and only when the target produced nothing else.
- For pattern claims, a passed synthetic result means the members are `missing` (the target emits no per-case output). A failed one means the members are `error`.

TARGET-SCOPE RESULTS (`rr.scope=target`)
- These come from:
  - wrap/rr_evidence `exit-status`;
  - rr_node_test `<exit-status>`, `<load>`, `<file>` (a failing root hook) and `<hooks>` (a describe or parent body failing outside its subtests);
  - JUnit the ingest cannot read.
- They are never members and never count as passing. They taint every member claimed on that target (state `error`), so each requirement fails through its own members.
- They are listed under `unattributed-failure` when no owned member is affected.

EXECUTION DIMENSIONS (not part of the identity; merged in resolve_cases)
- **Attempts:** the final `test.xml` is authoritative. If an earlier attempt failed or errored for that key (skipped does not count) and the final one passed, the result has `flaky=True` and records the number of attempts.
- **Runs (`--runs_per_test`):** the worst status wins, since every repetition must pass.
- **Shards:** the union of their cases. The same key in two shards is `duplicate-case`.
- **Two evidence roots** (sw plus hitl artifacts, rr_evidence plus testlogs): merged worst-of, keeping every source path. If their declared tags differ, the union may become `multi-tag`, which is fail-closed.
- **Duplicate names in one run** (two node tests named `dup` were verified in the probe): folded worst-of with `duplicate-case`; still one key and one owner.

SOURCE IDENTITY (`CaseResult.file` / `line`)
- Populated from:
  - `rr.file` written by the pytest and unittest hooks, JUnitWriter/CheckPlan (sys.argv[0]) and the node reporter (the event's `file`);
  - JUnit `file`/`line` attributes when a producer writes them.
- Ingest makes the path relative to the workspace by stripping any `*.runfiles/<ws>/` or `bazel-out/<cfg>/bin/` prefix.
- Used for same-code detection (P23) and for report links to the source.

STABILITY
- Renaming a test changes its key. The lock or a literal selector then reports `missing-case`, naming the nearest existing case by edit distance, and the lock diff shows the rename for review.
- Re-tagging never changes a key.
- The same code in two targets has two keys but one code identity; see P23.

AUTHORING AID
`rr cases --evidence bazel-testlogs [--target //web:clocksync_test] [--json]` prints every key with its status, synthetic flag, declared tags and file, so authors copy exact strings instead of guessing them. It needs no model and ships in v0.2.0.

## set_semantics

DEFINITION
Each verifiable entity E (requirement, user need, mitigation) has one declared set: the union of everything below. "Must pass together" is evaluated over that set.

Members of the set:
- **Owned members:** keys whose owner is E, whether through E's claims (model) or through tags (hybrid).
- **Expected members:** keys named by E's literal selectors, and lock entries whose value is E.
- **Pseudo-members:** a selector that matched nothing; a quarantined key that names E.

MEMBER STATES

| State | Meaning |
|---|---|
| passed / failed / error / skipped | From the merged result. A unittest expected failure and a node `todo` count as skipped. |
| error (tainted) | The target has a target-scope failure, or the member is a pattern member and the target produced only a failed synthetic result. |
| missing | The target ran (any result, or an empty suite written by rr_node_test) but the expected key is absent: a renamed or deleted test, `-k`/`--test_filter`, a parametrization id no longer generated, or a HITL check that was never planned. |
| not-run | No evidence at all for the target in this report: another lane, or a target that never built. |
| moved | A lock entry now owned by another entity or by nobody. |
| quarantined | See enforcement. |

VERDICT (trace.verdict_from_members, which replaces own(); the first matching rule wins)
1. Any member quarantined → **INVALID**.
2. Any member failed or error (including taint), or flaky with `flaky: fail` → **FAILED**.
3. No members at all, or every member not-run → **UNVERIFIED**. The gap reads "not run: <targets>", routed by member level, so a HITL member routes to human-gate.
4. Any member missing, moved, not-run or skipped, or mixed builds with `set_consistency: enforce` → **INCOMPLETE** (new). The reason breakdown reads, for example, "17/23 passed; 6 not run (//pi/hitl/harness:e2e_netstack)". `provided` = the best passed level so far.
5. Complete and all passed, with any of the following → **UNDER-VERIFIED**:
   - a stale member: on any shared artifact key, its artifact identity differs from `--current-build`. This is stricter than today's "fresh evidence wins": the whole set must hold on the current build. The `stale` flag is set and the `stale` gap raised.
   - a flaky member with `flaky: under-verify`, the default. A retry-masked pass never reads VERIFIED.
   - `classify(best member level, demanded)` is below the demand.
6. Otherwise → **VERIFIED**. `provided` is the maximum ordered level among the members: the whole set passed together, so its strongest evidence counts while the cheaper members supply the pyramid base.

LEVELS
- A member's level is the case's own `level` property if present, otherwise the claim's `level`, otherwise `config.default_provided_level`.
- If the case and the selector both state a level and they differ, the lower-ranked level is used (conservative) and `level-mismatch` is raised.
- The cost-pyramid check is unchanged, computed over the passed members.

CONSISTENCY
- `set_consistency` compares members stamped with different values for a shared `artifact.*` key, for example two `dut_git_sha` values within one set.
- `warn` (default) raises a `mixed-builds` gap. `enforce` makes the entity INCOMPLETE.
- Unstamped members (most software cases) never conflict.

FLAKY
The policy is `accept | flag | under-verify | fail`, default `under-verify`.
- **accept:** the member counts as passed.
- **flag:** passes, plus a `flaky` gap.
- **under-verify:** UNDER-VERIFIED.
- **fail:** FAILED.

Only an earlier failed or errored attempt makes a member flaky. CheckPlan records rig trouble as `skipped`, so infrastructure retries in hitl.yaml (`--flaky_test_attempts=3`) do not count as flakiness.

ROLLUPS
- `_rollup` treats INVALID like FAILED and INCOMPLETE like PARTIAL. `counts()` adds `requirements_invalid` and `requirements_incomplete`.
- Needs (`satisfies`), mitigations (`implemented_by`) and refinements (`refines`) propagate verdicts between entities, never cases. Each verdict carries `basis`: own / derived / own+derived, plus `derived_from`.
- A parent never lists a child's cases. A parent with its own claims must also have a complete set of its own.
- `parent-with-claims` (warning) nudges toward pure decomposition. splanc has no `refines` today.

LANES (no softening)
- `rr report --lane NAME` stamps the lane into the report.
- `--lane-targets FILE` lists the targets the lane is expected to run. It only labels not-run members as "out of lane (expected elsewhere)" and keeps their gaps out of `--queue-out`. Not-run members of in-lane targets stay as `not-run` gaps (the target should have run here).
- Verdicts are identical with or without these flags.
- So PR-13, whose set spans web, pytest and HITL members, reads INCOMPLETE in both the software and the HITL lane report. Only the combined report, run over both lanes' evidence (the Traceability site workflow on branch agent/traceability-pages), can read VERIFIED. That report is the authoritative V&V record.

THE LOCK

`rr sets lock --model M --evidence E... [--write] [--allow-removals]`
1. Refuses to write if attribution over E has any quarantine.
2. For every target present in E, the entries become exactly the owned keys observed.
3. For every target absent from E:
   - keeps entries that still match a claim of their locked owner, or that are tag-owned in hybrid mode;
   - adds literal-selector keys from the model;
   - assumes `[target]` for whole claims that have no entry yet.
4. Removals need `--allow-removals`: keys missing from a target that ran, and stale entries. The tool prints them, so a crashed or filtered run cannot shrink a set silently.
5. Owner changes are printed and allowed, because the model change that caused them is reviewed in the same diff.

`rr sets check --model M --evidence E...` (the CI gate)
- Runs the same computation without writing.
- Restricted to targets present in E, it exits 1 on `missing-case`, `unlocked-member`, `lock-owner-changed` and `lock-stale`.

`rr sets show PR-13` prints the set.

Without a configured lock, `rr report` emits one `unpinned-sets` gap listing the entities that have glob, whole or tag-owned members ("membership not pinned; a deleted test would go unnoticed"). It is visible, never silent.

GAPS ADDED
- `missing-case`: autonomous. Names the selector or lock entry and the nearest existing case.
- `incomplete`: one per INCOMPLETE entity, with the reason breakdown. Routed human-gate if any not-run or skipped member is above `autonomous_max_level`.
- `invalid`, `multi-tag`, `attribution-conflict`, `same-code-multiple-owners`
- `flaky`, `mixed-builds`
- `unlocked-member`, `lock-owner-changed`, `lock-stale`, `unpinned-sets`
- `unclaimed-tag`, `tag-mismatch`, `duplicate-case`
- `coarse-claim`
- `unattributed-failure`: replaces `untraced-failure`, which is still emitted alongside in 0.3.x.

WHY ONE SET PER REQUIREMENT
Alternative sets (OR) would let a failing set be ignored, so they are not offered. If a requirement really has independent proofs, the honest model is to refine it into child requirements.

## hitl_and_writers

WRITER (rules_requirements hooks/junit_writer.py)
- Each case carries at most one `requirement`. In model mode it is only a cross-check.
- `level` and `artifact` stamps work as today; they feed member levels and staleness.
- New `rr.file`. `cases` becomes a read-only tuple (0.3).

CHECKPLAN (new hooks/checkplan.py, re-exported from junit_writer; ships in v0.2.0)
```python
class CheckPlan:
    """A hardware run as ordered steps (actions, owned by nobody) and checks (assertions, one JUnit case each)."""
    def __init__(self, writer: JUnitWriter, steps: Mapping[str, Sequence[str]], *,
                 tags: Mapping[str, str] | None = None,     # "step.check" -> ONE id (declared tag)
                 is_infrastructure: Callable[[BaseException], bool] = lambda exc: False): ...
    def setup_done(self) -> None: ...
    @contextmanager
    def run(self) -> Iterator["CheckPlan"]: ...        # wraps the whole run
    @contextmanager
    def step(self, name: str) -> Iterator[None]: ...
    @contextmanager
    def check(self, name: str) -> Iterator[None]: ...  # inside the current step
    def passed(self, name: str, message: str = "") -> None: ...
    def failed(self, name: str, message: str) -> None: ...
    def skipped(self, name: str, reason: str) -> None: ...
```
- **Construction:** check names must be unique within a step. `tags` values must each be one well-formed id, otherwise ValueError RR-E101/E104. An unknown step or check name is a harness bug, recorded as `<suite>::harness` error.
- **Case naming:** classname `<suite>.<step>`, name `<check>`, so `hitl_e2e.flash_boot::ble_advertising`. The rig case is `<suite>::rig`.
- **`check(name)`:**
  - on success → passed;
  - on an infrastructure exception → records nothing and re-raises;
  - on any other exception → `failed "<Type>: <msg>"`, then re-raises.
- **`run()` on a normal end:** any planned check never recorded → `error` "planned check never executed (harness bug)".
- **`run()` on an exception:**
  - **Rig or setup trouble** (before `setup_done()`, or `is_infrastructure(exc)`):
    - an untagged, unowned error case `<suite>::rig` (not target-scope, so passed checks stay valid);
    - every unrecorded planned check → `skipped` "not run: rig trouble: <exc>";
    - the owners read INCOMPLETE, never FAILED. This keeps today's "rig trouble fails nothing" rule.
    - In v0.2.x only, CheckPlan also withdraws the tags of passed checks whose tag also sits on a skipped check. That is the old semantics' equivalent of INCOMPLETE, and exactly what e2e_phases.record_incomplete does today. 0.3 drops the withdrawal because sets make it redundant; the verdict is "not VERIFIED, not FAILED" under both.
  - **Device failure:** every unrecorded planned check (the rest of this step and all later steps) → `failed` "not reached: <step> failed: <exc>". Each one is still one case with one owner, so each requirement fails through its own checks.
  - In both cases the exception is re-raised.

SPLANC pi/hitl/harness/e2e_phases.py (step S5)
- `PHASES: dict[str, list[str]]` (phase → several PRs) is replaced by:
```python
STEPS = {
    "flash_boot": ("ble_advertising",),               # + "heap_headroom" once its assertion exists
    "improv_provision": ("provisioned",),             # + "readiness_retry" once its assertion exists
    "websocket_checks": ("ws_connect", "build_info", "time_sync", "rename", "board_caps", "cert_page"),
    "run": ("completed",),                            # the e2e flow ran end to end
}
TAGS = {  # single-id cross-checks; the model owns attribution in model mode
    "flash_boot.ble_advertising": "PR-13", "improv_provision.provisioned": "PR-13",
    "websocket_checks.ws_connect": "PR-13", "websocket_checks.time_sync": "PR-13",
    "websocket_checks.rename": "PR-13", "websocket_checks.cert_page": "PR-13",
    "websocket_checks.build_info": "PR-35", "websocket_checks.board_caps": "PR-35",
    "run.completed": "PR-23",
}
def plan_for(report, phases):
    return CheckPlan(report, {p: STEPS[p] for p in [*phases, "run"]}, tags=TAGS,
                     is_infrastructure=is_infrastructure)
```
- `planned()` and `is_infrastructure()` stay. `phase()`, `tracked()`, `record_incomplete()` and `_SETUP_DONE` are deleted, including the mutation of `case.requirements` and the multi-PR `incomplete_run` case.
- In hitl_e2e.py:
  - `run()` uses `with plan.run():`, calls `plan.setup_done()` where `setup_done(report)` is called today, and uses `with plan.step(...)` where `with phase(...)` is used today.
  - `flash()` wraps its BLE_MARKER assertion in `plan.check("ble_advertising")`. Failures of the flash action itself (hitl-flash exit, ensure_booted) raise in the step body, which is a device failure.
  - `provision_dut` success → `plan.passed("provisioned")`.
  - `_ws_checks` takes the plan. Each assertion block it already has becomes its own check: the connect loop → `ws_connect`; welcome fwGitCommit/fwGitDirty/fwVersion → `build_info`; the min-RTT sample → `time_sync`; the set_device_name echo → `rename`; the board_caps diff → `board_caps` (`skipped` when there is no descriptor in runfiles).
  - `cert_page_check` → `cert_page` (`skipped` for plain ws).
  - At the end: `plan.passed("completed")`.

HONEST CONSEQUENCES
- No assertion measures heap headroom (PR-21), unsafe-allocation aborts (PR-26) or readiness/reconnect hardening separately (PR-29). PR-22 ("preserve user work across transient disconnects") is exercised by nothing in websocket_checks.
- These PRs lose the HITL evidence they borrow from shared phases today. They read UNVERIFIED or INCOMPLETE at hitl until real checks exist.
- Candidate new checks (gap-closing work):
  - `flash_boot::heap_headroom`: free-heap floor parsed from serial (PR-21);
  - `improv_provision::readiness_retry` (PR-29);
  - a dedicated "abort unsafe workload" check (PR-26).
- A check is added to STEPS only when its assertion exists, because a planned but unimplemented check records `error`.

MODEL ENTRIES (splanc requirements.yaml, step S7)
```yaml
- id: PR-13
  verified_by:
    - target: //pi/hitl/harness:e2e_netstack
      cases: [hitl_e2e.flash_boot::ble_advertising, hitl_e2e.improv_provision::provisioned,
              hitl_e2e.websocket_checks::ws_connect, hitl_e2e.websocket_checks::time_sync,
              hitl_e2e.websocket_checks::rename, hitl_e2e.websocket_checks::cert_page]
    - {target: //web:clocksync_test, cases: ["clocksync::*"]}
- id: PR-23
  verified_by:
    - {target: //pi/hitl/harness:e2e_netstack, cases: [hitl_e2e.run::completed]}
    - {target: //pi/hitl/tests:hitl_test, cases: ["pi.hitl.tests.test_e2e_phases::*"]}
```
Literal HITL selectors pin themselves: a check that is renamed or never planned shows `missing`.

OTHER HITL TARGETS
- They are untagged today and produce Bazel's synthetic result. Each gets one owner or none, as a whole claim with `level: hitl` and a `reason`.
- Proposals for the owner and the gap-closing agent:

| Target | Proposed owner |
|---|---|
| tls_churn_netstack | PR-21 |
| video_stream_netstack | PR-10 |
| map_upload_netstack | PR-12 or PR-31, never both |
| fx_bench_netstack + fx_bench_jit_netstack | one owner, e.g. PR-27; declared in `variants` |
| led_capture_netstack + led_capture_jit_netstack | one owner, e.g. PR-20; declared in `variants` |

- Moving these scripts to JUnitWriter or CheckPlan later (for example fx_bench per-effect cases) gives per-case members and automatic same-code detection through `rr.file`.

TESTS (pi/hitl/tests/test_e2e_phases.py, rewritten at S5)
- Every check is its own case, and no case declares more than one id.
- A device stop gives failed "not reached" cases; rig trouble gives only `rig` plus skipped checks; a normal end gives no error cases.
- Through `parse_documents` + `build_matrix` with a fixture model:
  - device failure → the affected PRs read FAILED;
  - rig trouble → not VERIFIED and not FAILED (this assertion survives the 0.2 → 0.3 bump);
  - full pass → VERIFIED.
- At S7 the fixture model gains selectors and asserts INCOMPLETE exactly. Verified on a rig through the hitl skill (`//pi/hitl/harness:e2e_netstack` under a reservation) before merge.

WORKFLOWS
- At S9, hitl.yaml's report reads the whole testlogs directory, since 0.3 merges attempts, instead of `**/test.xml`.
- The hitl-traceability-evidence and traceability-evidence artifacts add `test_attempts/*.xml`, so flaky detection works in the combined report.

## typescript_node_test

TODAY
- Each web/tests/*.test.ts is compiled to CommonJS under dist-test/ and run by aspect_rules_js `js_test(entry_point=...)` as a plain node script (direct mode, not `--test`).
- Bazel writes its synthetic one-case test.xml, so 77 targets (about 524 `test()`/`it()` calls) give 77 opaque verdicts.
- 25 of those targets are cited in `verified_by`, and 6 are shared between PRs.

VERIFIED NODE FACTS (Node 22.22.0, the rules_js 3.2.2 toolchain in this checkout's output base; probes in the design-time prototypes (not published; superseded by v0.2.0–v0.3.0))
- `--test-reporter=<module>` works in direct mode, so execution matches today's js_test exactly.
- `test:start` events carry `nesting`. A test's `test:pass`/`test:fail` is followed by its own `test:diagnostic` events, with the same nesting and line, even under `describe(..., {concurrency: 3})`.
  - The earlier Ledger sketch looked diagnostics up at pass time with `nesting - 1`, which is wrong on both counts.
- `details.type === 'suite'` marks a describe. A test with subtests has type 'test', so "leaf" means "had no child test:start".
- skip and todo arrive as test:pass with `skip`/`todo` set.
- A require-time throw emits no events and exits 7.
- An unhandled rejection after the tests emits only a root-level diagnostic, a pass for the test, and exit 1.
- A failing root `after()` hook emits a test:fail with no test:start and still exits 0 in direct mode, so Bazel passes the target. The rr runner records it as a target-scope error, so the report is stricter than Bazel here.

rules_requirements js/ (no npm dependencies)

1. `js/rr_node_reporter.mjs` is a custom reporter (an async generator) that yields nothing and appends JSON lines to `$RR_CASES_OUT`:
   - It keeps a stack from `test:start` with child counts.
   - A leaf `test:pass`/`test:fail` becomes a case:
     - classname = file stem plus the describe/parent chain joined with " > ";
     - name = the test name;
     - status passed, failed, or skipped (skip/todo);
     - plus message, duration, file and line.
   - A suite or parent failure whose `failureType` is not `subtestsFailed` becomes a target-scope `<chain>::<hooks>` error.
   - A `test:fail` with no matching `test:start` (a root hook) becomes `<stem>::<file>`.
   - A `test:diagnostic` matching `^rr\.(requirement|level|artifact\.[\w.-]+)=(.+)$` attaches to the most recently completed leaf if file, nesting and line match. Otherwise it is an `uncorrelated` warning. It never taints, because tags are not attribution.
2. `js/node_test_main.cjs.tpl` is the entry point. The rule bakes in TEST_REL, REPORTER_REL, TARGET and LEVEL. At run time it:
   1. spawns `process.execPath` with `[...process.execArgv, '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=' + reporter, '--test-reporter-destination=stderr', testFile, ...argv]`, with env RR_CASES_OUT, RR_TEST_FILE and RR_TARGET. execArgv and NODE_OPTIONS carry rules_js's node flags into the child.
   2. renders JUnit after the child exits:
      - a passed/failed/skipped case for each leaf, with `requirement`/`level` properties from diagnostics and `rr.file`;
      - `<stem>::<load>` (rr.scope=target) if the child exited non-zero before reporting anything;
      - `<stem>::<exit-status>` (rr.scope=target) if it exited non-zero, or was killed by a signal, while no case failed;
      - an empty `<testsuite tests="0">` if there were zero tests and exit 0, so claimed members read `missing`.
   3. writes `$XML_OUTPUT_FILE` via `.tmp` + rename.
   4. exits with the child's code. The wrapper never changes pass/fail.
   - On Node < 20 it runs the file plainly and writes one `rr.synthetic=true` result, which is today's behaviour.
   - XML escaping matches junit_writer.xml_safe.
   - The design-time prototype reporter and runner passed every probe listed above.
3. `js/verifies.cjs` is an optional cross-check helper:
```js
const seen = new WeakMap();
exports.verifies = (t, id, level) => {
  const prev = seen.get(t);
  if (prev && prev !== id) throw new Error(`rr.verifies(${id}): test already verifies ${prev} [RR-E101]`);
  if (!/^[A-Za-z][\w]*-\d+$/.test(id)) throw new TypeError(`rr.verifies: '${id}' is not ONE id [RR-E104]`);
  seen.set(t, id); t.diagnostic(`rr.requirement=${id}`); if (level) t.diagnostic(`rr.level=${level}`);
};
```

BAZEL (`load("@rules_requirements//rr:defs.bzl", "rr_node_test")`; implementation in rr/private/node.bzl)
```starlark
def rr_node_test(name, rule, test, data = [], args = [], level = "", **kwargs):
    """`rule` = js_test from @aspect_rules_js//js:defs.bzl (no rules_js dependency here, like rr_rust_test(rule = rust_test))."""
    _rr_node_files(
        name = name + ".rr_node", test = test, level = level,
        target = "//%s:%s" % (native.package_name(), name),
        main_out = name + ".rr_node_main.cjs", reporter_out = name + ".rr_node_reporter.mjs",
        testonly = True, tags = ["manual"], visibility = ["//visibility:private"],
    )
    rule(name = name, entry_point = name + ".rr_node_main.cjs",
         data = data + [test, name + ".rr_node_reporter.mjs"], args = args, **kwargs)
```
- `_rr_node_files` expands the two templates into the caller's package (bin tree, as rules_js requires). It computes the runfiles-relative path from the main to `ctx.file.test.short_path` in Starlark, with a small relpath helper that handles `../repo/` short paths.
- Paths are baked in rather than passed through `$(rootpath)` args, so they also work under rr_evidence, the same reason `_rr_main` bakes args.

SPLANC web/BUILD.bazel (step S2a; the only build edit, no test-source edits)
```starlark
load("@rules_requirements//rr:defs.bzl", "rr_node_test")
[
    rr_node_test(
        name = f.removeprefix("tests/").removesuffix(".test.ts") + "_test",
        rule = js_test,
        test = ":dist-test/" + f.removesuffix(".ts") + ".js",
        data = [":web_tests_js", ":dist_test_pkg_json"],   # pins the CJS scope for the child
    )
    for f in glob(["tests/*.test.ts"])
]
```
- Target names do not change, so `:unit_tests` and CI are unchanged.
- Resulting keys look like `//web:clocksync_test#clocksync::bestSample keeps the min-RTT sample`.
- The model claims `clocksync::*` or literal names. In-test `verifies(t, "PR-13")` is optional.

EDGE CASES
- Duplicate test names in one file → `duplicate-case`.
- `{skip}`/`todo` → skipped, so the owner reads INCOMPLETE, never VERIFIED. Only topology.test.ts uses skip/todo today, and it is uncited.
- A require-time throw, a late unhandled rejection or a failing root hook → target-scope taint, so every member on that target reads error.

TESTS (rules_requirements)
- `tests/node/` adds aspect_rules_js as a dev_dependency, with `rr_node_test(rule = js_test)` fixtures for every probe:
  - nesting, subtests, concurrency;
  - skip/todo, duplicates;
  - diagnostics after the pass event;
  - root after-hook failure, late rejection, load error;
  - zero tests.
- They run under rr_evidence, with a golden of the ingested case keys and states.
- A conformance job runs the fixtures on Node 20, 22 and 24, so a change in Node's event model breaks rules_requirements CI, not consumers.

TO VERIFY AT S2a (one target first, then the comprehension)
- every target's test.xml case count equals its `test()`/`it()` count;
- `bazel test //web:unit_tests` stays green;
- the child inherits rules_js's node flags.

## report_and_editor

REPORT (report/__init__.py, report/html.py; schema `rules_requirements/report/v2`)
```json
{"schema": "rules_requirements/report/v2",
 "summary": {"requirements_incomplete": 3, "requirements_invalid": 0, "test_cases": 1043,
             "test_cases_owned": 812, "test_cases_unowned": 231, "test_cases_quarantined": 0},
 "attribution": {"mode": "model", "lock": "requirements/verification.rrlock", "lane": "software",
   "targets": {"//web:clocksync_test": {"cases": 4, "owned": 4, "owners": ["PR-13"], "synthetic": false}},
   "quarantined": [], "issues": [{"code": "unclaimed-tag", "case": "…", "declared": ["PR-12"]}],
   "granularity": {"owned_by_literal": 401, "owned_by_pattern": 380, "owned_by_whole": 3,
                   "owned_by_tag": 0, "coarse_claims": 0}},
 "cases": [{"case": "//web:clocksync_test#clocksync::bestSample keeps the min-RTT sample",
            "target": "//web:clocksync_test", "path": "clocksync::bestSample keeps the min-RTT sample",
            "owner": "PR-13", "via": "model", "status": "passed", "level": "simulation",
            "declared": [], "file": "web/dist-test/tests/clocksync.test.js"}],
 "requirements": [{"id": "PR-13", "status": "INCOMPLETE", "basis": "own",
   "set": {"complete": false, "members": 23, "passed": 17, "missing": 0, "not_run": 6, "skipped": 0, "failed": 0},
   "members": [{"case": "…", "selector": "clocksync::*", "via": "model", "state": "passed", "level": "simulation"},
               {"case": "//pi/hitl/harness:e2e_netstack#hitl_e2e.websocket_checks::rename", "state": "not-run",
                "lane_hint": "out of lane"}],
   "evidence": ["…compatibility view derived from members (0.3.x only)…"]}]}
```
- **`cases`** is the inverse matrix: case → one owner or null. It is the input to `rr check-report`.
- **Per entity:** `basis` and `derived_from` are added.
- **Compatibility:** `kind: "target"` evidence refs disappear, because whole claims expand to members. The `evidence[]` compatibility view is kept for 0.3.x.

MARKDOWN AND HTML
- A red banner at the top for quarantined cases. Each entry lists the case, the code and every claim origin.
- Each requirement row shows "set 17/23 passed · 6 not run (hitl)". It expands to a member table (case, state, level, via, lane hint, and a source link when `--scan` located the selector or tag).
- New badges: INCOMPLETE (PARTIAL colour family) and INVALID (FAILED family).
- New sections:
  - "Case attribution": per target owned/unowned counts and the list of unowned cases. This is the granularity backlog.
  - "Lock drift".
  - "Coarse claims".

CLI (cli.py)
- `rr report` gains:
  - `--sets-lock PATH | --no-lock`
  - `--lane NAME`
  - `--lane-targets FILE`
  - `--on-attribution-error {fail,warn}`
  - exit 3 (see enforcement)
  - `--fail-on failed` counts INVALID; `--fail-on unverified|gaps` counts INCOMPLETE.
- New commands:
  - `rr attribution --model M --evidence E [--target T] [--unowned] [--format tsv|json] [--check] [--suggest]`: prints key, owner, via and declared tags. `--suggest` prints the YAML selector to add for each `unclaimed-tag`. `--check` exits 1 on quarantine, missing cases, lock drift or error-level issues.
  - `rr cases --evidence E [--target T] [--json]`: model-free; v0.2.0.
  - `rr sets lock [--write] [--allow-removals]`, `rr sets check`, `rr sets show ID`
  - `rr migrate plan --model M --evidence E... --out FILE.rrplan [--agent]` (v0.2.0)
  - `rr migrate apply FILE.rrplan --stage tags|model [--compress] [--strip-tags] [--unassigned refuse|drop] [--dry-run]`: `--stage tags` in v0.2.0, `--stage model` in v0.3.0.
  - `rr check-report REPORT.json`
  - `rr case …` (shell harnesses)
- Changed commands:
  - `rr validate --known-targets FILE`. When $XML_OUTPUT_FILE is set, `rr validate` writes one JUnit case per check family (`rr.validate::shape`, `::references`, `::coverage-rules`, `::claims`, `::lock`), so `//requirements:model_test` becomes per-case.
  - `rr ingest` prints `declared`, `scope`, `synthetic`, `attempt` and `file`.
  - `rr wrap --format junit --junit-in PATH`

BAZEL
- `rr_model(lock = "verification.rrlock")`: the validation test also checks the lock statically. `RrModelInfo` gains `lock`.
- `rr_report(check = True, lane = "", on_attribution_error = "fail")`: `check = True` adds `<name>_check_test` running `rr check-report`.
- `rr_sets_lock_test(name, model, evidence)` with `.update`, for hermetic projects using rr_evidence such as thermostat.
- `rr_node_test`, `rr_wrapped_test(format = "junit", junit_in = ...)`, `@rules_requirements//cc:case`.

WEB EDITOR (rr serve)
- **server/workspace.py:**
  - `Snapshot` keeps the `Attribution`.
  - `create`/`update`/`rename`/`_retarget` build the candidate model and run `validate()` plus `attribute()` against the cached evidence. They refuse with `WorkspaceError(..., 409)` if the edit introduces `shared-case`, `same-code-multiple-owners`, `bad-selector`, `bad-target` or `lock-owner-changed` for the edited entity. Example message: "this would make //web:clocksync_test#clocksync::bestSample keeps the min-RTT sample verify both PR-13 and PR-29; a test case verifies at most one requirement".
  - New `cases(target, q, unowned)` and `precheck(entity_id, data)`.
  - `entity_payload` gains `set`, `members`, `basis` and `derived_from`.
- **server/app.py:**
  - `GET /api/cases?target=&q=&unowned=1`
  - `GET /api/attribution`
  - `POST /api/entities/{id}/precheck`: a live dry run.
  - `POST /api/lock/update`: the same logic as `rr sets lock` over the loaded evidence; removals need confirmation.
- **views/editor.js — "Verification set" widget, one row per selector:**
  - target input, autocompleted from evidence targets;
  - mode: Cases / Whole target (whole requires a reason);
  - level select;
  - for Cases: a checklist of the target's observed cases with status, plus a free-text pattern box and a live "matches 4 cases" count;
  - cases owned by another entity are disabled and labelled "owned by PR-29";
  - precheck problems show inline and disable Save; the 409 backs this up.
- **Other views:**
  - **entity.js:** set table with state chips (missing, not-run, quarantined, flaky, stale), `derived_from`, and a banner when the lock is out of date.
  - **list.js:** new route `#/cases` listing every case with its owner, filterable by unowned, quarantined, unlocked, coarse and lane.
  - **overview.js:** an invariant tile: "N cases · 0 quarantined · each case → ≤1 requirement".
- **graph.py:** optional `--cases` adds case nodes, each with exactly one in-edge.

AGENTS (agents/workflows.py)
- Context comes from `matrix.attribution.members_of(req)`. Line 398 reads raw tags through `evidence.for_id` today.
- New `assign-cases` workflow: given unowned or quarantined cases, or a worksheet row, it proposes exactly one owner or `none`, with a rationale from the test name, docstring and source against requirement text. It writes proposals into the `.rrplan` worksheet for human approval and never edits the model or test sources directly.

## splanc_migration

PART A — rules_requirements IMPLEMENTATION PLAN (ordered; each step lands with its tests, golden regenerations and docs)
Changes go to Studio-Fug/rules_requirements by SSH tree-squash to main, one squash per milestone, because that org has no PR API. Each milestone ends with a tag. rules_requirements' own CI stays green because every step ships its tests and regenerated goldens together.

M1 → v0.2.0 "per-case runners and migration tooling": additive, no verdict changes. Acceptance: the thermostat and integration report goldens are byte-identical.
- **A1.** `js/` reporter, main template and verifies helper; `rr/private/node.bzl`; `rr_node_test`; tests/node fixtures (aspect_rules_js as dev_dependency) and the Node 20/22/24 conformance job. Docs: guides/hooks "node:test".
- **A2.** `cc/rr_case.h` and `//cc:case`. Integration `rr_case_test.cc` with one deliberately failing case under rr_evidence, plus a golden. Docs.
- **A3.** JUnitWriter: singular `requirement`, list deprecation, `file`/`rr.file`, `not_reached`. `hooks/checkplan.py`, including the v0.2-only tag withdrawal. test_hooks.py cases: device stop, rig trouble, harness bug, single-id validation.
- **A4.** CaseKey/path helpers; `rr cases`; `rr migrate plan` (worksheet from today's union semantics); `rr migrate apply --stage tags` (pytest/unittest codemod via `ast`, black-stable). Test fixture repos. Draft docs/guides/migrating-to-per-case.md.
- **A5.** DeprecationWarnings for multi-id pytest markers, rr.verifies and JUnitWriter; `rr case`; `rr wrap --format junit`. Release notes.

M2 → v0.3.0 "one owner per test case": semantic.
- **B1.** labels.py, case_selectors.py; model.py (VerifiedBy, Claim, `claims()`, `validated_by`/`verified_by`); config.py keys and rules; validate.py `check_claims`, `check_lock`, `--known-targets`; JSON schemas; edit.py round-trips. Tests: test_case_selectors (exhaustive brute-force cross-check), test_labels, test_validate (witness messages, whole-vs-pattern, cross-kind, variants, legacy), test_edit.
- **B2.** Ingest: `declared` with a `requirements` alias; synthetic fingerprint; `rr.scope`/`rr.synthetic`; attempt/run/shard; file/line; nested `<testcase>` (children become a scope instead of being dropped); `[rr:ID]` name tags; records `requirement` and document-level target; suite-level requirement no longer inherited; unreadable JUnit is target-scope. test_ingest.
- **B3.** attribution.py and lock.py. test_attribution: P1–P31 regressions plus the 10k fuzz. test_lock.
- **B4.** trace.py: `verdict_from_members`, INVALID/INCOMPLETE, basis/derived_from, flaky/mixed/stale, new gaps, counts, rollups, `Matrix.attribution`; `Evidence.for_id` deprecated. test_trace rewritten around sets.
- **B5.** Hooks: bazel.py and wrap.py exit-status without ids; pytest nearest-scope single id, `rr.file`, RR-E102 guard; unittest; JUnitWriter read-only cases; CheckPlan drops the tag withdrawal; gtest `requirement` property; Rust single-id trace lines. Integration tests: multi-id cases become quarantine tests.
- **B6.** Report v2 (JSON/MD/HTML); CLI (exit 3, `--on-attribution-error`, lanes, `attribution`, `sets`, `check-report`, `migrate apply --stage model`, per-check `validate` JUnit); Bazel (`rr_model(lock)`, `rr_report(check)`, `rr_sets_lock_test`). Regenerated goldens.
- **B7.** Editor and agents. test_workspace / test_server: 409 guard, precheck, `/api/cases`.
- **B8.** examples/thermostat moves to model mode with a lock, a records target, and `rr::verifies!` split to one id. Docs: concepts ("One test case, one requirement"), guides model/evidence/hooks/outputs/integration/bazel/web-editor, standards, migration guide. Release notes.

M3 → v0.4.0 "strict": default `attribution: model`; hybrid gives a `hybrid-mode` warning; multi-id hooks become hard errors (pytest UsageError, rr.verifies TypeError/ValueError, JUnitWriter ValueError, single-arg RR_VERIFIES with ADD_FAILURE guards, single-arm `verifies!` with a panic guard); aliases, `evidence[]` and `untraced-failure` removed; `bare-target-reference` and `multi-verifies-annotation` default to error.

PART B — SPLANC MIGRATION (one PR per step)
Gating jobs on a PR:
- `test`: `bazel test //...`, which includes `//requirements:model_test`.
- `lint`: prek, with black, flake8 and buildifier.
- `traceability-report`: model_test and check_annotations gate. `rr report` fails only on an invalid model (rc 2), and on quarantine (rc 3) after S6.

Post-merge workflows: HITL, and the Traceability site (agent/traceability-pages, pending).

| Step | Pin | Change | Why CI stays green / verdict effect |
|---|---|---|---|
| S0 | any | Freeze rules for concurrent work, including the gap-closing agent's work: never cite a target from a second PR; new Python tests use single-id markers; new HITL checks name one PR. | Process only. |
| S1 | v0.2.0 | MODULE.bazel `git_override` commit and lockfile. | No semantic change. Check: report JSON before and after is identical. |
| S2a | v0.2.0 | web/BUILD.bazel uses `rr_node_test` (typescript_node_test). | The runner preserves exit codes. Whole refs still roll up the worst per-case status; only uncited topology.test.ts has skips. Check: per-target case counts. |
| S2b | v0.2.0 | `rr_rust_test(rule = rust_test, ...)` for ffi_test and counting_preempt_test (`env = {"RUST_MIN_STACK": "16777216"}` passes to the wrapper and is inherited by the binary), `//solver:solver_test` (`crate`, `data`) and `//tools/touchdesigner/stream_bench:stream_bench_test`. | Exit codes preserved; same whole-target rollup. |
| S2c | v0.2.0 | firmware/player_app improv_codec_test.cc, ws_codec_test.cc, color_correction_test.cc: `main()` becomes `return rr::RunCases(argc, argv, "improv_codec", {{"wifi_settings_vector", test_wifi_settings_vector}, ...});` with deps `+ @rules_requirements//cc:case`. `assert`s stay; `RR_CHECK` optional. | Exit 1 if any case fails, as before. |
| S3 | v0.2.0 | `rr migrate plan` over the latest main traceability-evidence and hitl-traceability-evidence artifacts → `requirements/attribution.rrplan` (YAML content). `.rrplan` stays out of the model, because CI passes `--model requirements` as a directory. Owners fill every `?` (Part C). | Data file only. |
| S4 | v0.2.0 | Parallel PRs over disjoint files (fleet-friendly): `rr migrate apply --stage tags --only pi/server` (then pi/hitl/tests, pi/led_driver, pi/reconstruction). Multi-id module `pytestmark`s become per-test single-id markers, or one module-level single id when the whole module has one owner; cases decided `none` lose their marker. Also: PR-23 drops `//requirements:model_test`, which stays with PR-25. | Single-id markers are valid today; run `prek run` (black/flake8). Verdicts change honestly, e.g. PR-13 loses about 35 test_handler cases to PR-11. |
| S5 | v0.2.0 | HITL CheckPlan restructure (hitl_and_writers), test_e2e_phases rewrite; verified on a rig. | The hitl_test unit tests gate in `test`. The 0.2 CheckPlan reproduces today's "rig trouble fails nothing and verifies nothing incomplete". |
| S6 | v0.3.0 | Pin bump. The 6 shared web targets (pinhole, clocksync, improv_provision, flashUsb, flashEnv, costModel) become `{target, cases}` selectors per the worksheet. `config: {attribution: hybrid, main_repo: splanc}`. Other legacy whole refs stay (`bare-target-reference` warnings; model_test is not strict). | No `shared-case` remains, so the model is valid. No multi-id evidence remains after S4/S5, so there are no quarantines and rc stays 0 (confirm locally with `rr attribution --check` before merge). JUnitWriter.cases is read-only, but nothing mutates it after S5. test_e2e_phases assertions are written to hold under both semantics. HITL post-merge: CheckPlan single ids → no quarantine. |
| S7 | v0.3.0 | Run `rr migrate apply --stage model --compress` over the latest sw evidence plus HITL evidence from a run after S5. It writes explicit selectors for every current owner, then asserts that the owner table is unchanged and that `check_claims` passes. Then: `config: {attribution: model, sets_lock: verification.rrlock}`; `rr sets lock --write`; single-id tags kept as cross-checks; test_e2e_phases fixture model gains selectors and asserts INCOMPLETE exactly. Glob compression skips groups containing skipped cases, which get literals. Permanently skipped cases are flagged for `none` or to be made runnable. | Verdicts identical to S6 by construction. Lock consistent. |
| S7 CI | v0.3.0 | Two additions to the traceability-report job (snippet below the table). Also: `--lane software --lane-targets <(bazel query 'tests(//...) except attr(tags, "\bmanual\b", tests(//...))')` on the report, then `rr check-report traceability-report.json`. | New gates pass on the migrated state. |
| S8 | v0.3.0 | Granularity: remaining whole claims become `cases: ["*"]` where per-case output exists. `whole` stays only for synthetic-only targets, each with a `reason`: HITL harness scripts without JUnit, and model_test until it emits per-check JUnit, after which PR-25 claims `rr.validate::*`. Rules: `whole-target-reference: error`, `bare-target-reference: error`. Declare `variants` for fx_bench and led_capture. Follow-ups: HITL scripts move to JUnitWriter/CheckPlan. | Statically checked; verdicts unchanged except as coarse claims become per-case. |
| S9 | v0.3.0 | Combined report becomes authoritative: test.yaml and hitl.yaml evidence artifacts add `test_attempts/*.xml`; hitl.yaml reports over the testlogs directory with `--lane hitl --lane-targets <(bazel query 'attr(tags, "\bhitl\b", tests(//...))')`; traceability_site.py runs `rr check-report` on the combined JSON; `flaky: under-verify` confirmed or relaxed by the owner. | Report-only workflows. |
| S10 | v0.4.0 | Pin bump. | No changes expected once S7 is done. |
| Docs | — | docs/requirements-driven-development.md (its line-68 example `pytestmark = pytest.mark.requirements("PR-13", "PR-29", level="hitl")` changes) and the requirements.yaml header comment: one test case, one requirement; how to write selectors; the lock workflow (`bazel test //...` then `rr sets lock --write`). | Ships with S7. |

S7 CI snippet for the traceability-report job:
```yaml
- name: Attribution checks (one test case, one requirement)
  run: |
    bazel query 'tests(//...)' > "$RUNNER_TEMP/targets.txt"
    bazel run @rules_requirements//python:rr -- validate requirements --known-targets "$RUNNER_TEMP/targets.txt"
    bazel run @rules_requirements//python:rr -- sets check --model requirements --evidence "$(readlink -f bazel-testlogs)"
```

PART C — PROPOSED OWNERSHIP DECISIONS (worksheet defaults; the PR owner confirms each; test names verified against sources)

Shared web targets:
- **//web:clocksync_test (4 cases):** all → PR-13. PR-29 drops it.
- **//web:improv_provision_test:**
  - "provisionViaBle: sends the correct wifi-settings wire and returns the redirect" and "...surfaces a device error notification as a rejection" → PR-13
  - "...survives Android's first-attempt GATT flake via retry" → PR-29
- **//web:flashUsb_test (6, USB VID/PID → chip family):** → PR-15.
- **//web:flashEnv_test:**
  - isMobileUserAgent, capable desktop, isAndroidUserAgent, Android WebUSB polyfill, Android native Web Serial → PR-16
  - iOS mobile-specific reason, desktop without either API, insecure context → PR-32
- **//web:costModel_test:**
  - "estimateFrameTime … reports a budget fraction" and "confidenceOf colorizes by fit likelihood" → PR-18
  - the other 9 (parseFxb, walkEntry ×3, histCycles ×2, mathFeature, costFor, dynamic histogram) → PR-27
- **//web:pinhole_test:** lookAtQuat, project → PR-34; quatToRotMat → PR-11.
- **//requirements:model_test:** → PR-25 (whole).

Multi-id pytest modules:
- **test_rust_parity, test_proto_wire:** → PR-34.
- **test_graycode:** golden-vector cases → PR-34; the rest → PR-11.
- **test_handler, test_app_integration:** → PR-11. The PR-13 claim was an overclaim.
- **test_session:** reconnect/resume → PR-22; the rest → PR-11.
- **test_reconstruct:** large or interrupted capture recovery → PR-31; the rest → PR-11.
- **test_map_upload, test_mapping_trigger:** batching/scale → PR-12; interruption/recovery → PR-31.
- **test_improv, test_sync:** wire/sync → PR-13; retry/readiness → PR-29.
- **test_video_bench:** → PR-10, except test_bars_effect_src_declares_texture_and_samples_it → PR-17.
- **test_fx_bench:** golden/margin/calibration → PR-27; run_health/stable_cycles → PR-17.

Review flag: do the pi/hitl/tests harness unit tests verify product PRs, or PR-23/PR-36 (HITL infrastructure)? Decide per module.

HITL checks: as in hitl_and_writers.

PART D — RISKS SPECIFIC TO SPLANC
- **The verified count drops honestly.** HITL PR-21, PR-22, PR-26 and PR-35 are VERIFIED today only through shared phases. Lane reports show INCOMPLETE for cross-lane sets; the combined report is the record. Communicate this as a correction, not a regression.
- **Owner effort:** about 25 module or target decisions plus per-case exceptions. The suggestions are heuristics, and the PR owner decides, not an agent.
- **S7 depends on fresh evidence:** a HITL run after S5 (via the hitl skill or a main run).
- **Fleet hygiene:** run the codemod in one foreground command; never `git add -A` in pi/hitl; rebase in a /tmp worktree to dodge the linter race.
- **Concurrent model edits** by the gap-closing agent: rebase on S6/S7, and add per-case selectors from then on.

## backward_compat

v0.2.0: ADDITIVE
- No verdict, report or model change. The thermostat and integration goldens are byte-identical.
- New, opt-in: `rr_node_test`, `rr_case.h`, CheckPlan, `rr cases`, `rr migrate plan` / `apply --stage tags`, `rr case`, `rr wrap --format junit`.
- JUnitWriter accepts both `requirement=` and the old positional list.
- Multi-id hook usage keeps today's union semantics but emits a DeprecationWarning. splanc has no `filterwarnings=error`, so this cannot turn a test red.

v0.3.0: SEMANTIC (the intended breaks; release notes plus the migration guide)

Model:
- Bare-string and `{target, level}` `verified_by` items still parse, as legacy whole claims with a `bare-target-reference` warning.
- Two entities naming one target is now `shared-case`, a hard error. `rr migrate plan` lists every such pair before the bump, and the consumer's pin-bump PR must carry the fix.
- New keys (`cases`, `whole`, `reason`, `validated_by`, `verified_by` on mitigations, the six config keys, the new rule names) are rejected by v0.2 as unknown fields or keys. A newer model therefore fails loudly on an older ruleset instead of silently losing traces.

Evidence:
- Multi-id cases from any producer are quarantined: INVALID, exit 3.
- Old JUnit (repeated or comma `requirement` properties, the gtest `requirements` property) still parses.
- `test_attempts` are merged instead of double-counted.
- Suite-level requirement properties are no longer inherited.
- Bazel synthetic results are recognised.

Re-ingesting archived 0.1 evidence shows its multi-counts as quarantines. There is deliberately no "legacy many-to-many" switch, because one would make the guarantee optional.

Python API:
- `TestCase.requirements` becomes a read/write alias of `declared`, with a DeprecationWarning, so third-party ingestors keep working.
- `build_matrix(model, evidence, current_build, references)` keeps its signature and adds a keyword-only `lock=None`. `Matrix.attribution` is new.
- `Verdict` gains `members`, `basis` and `derived_from`. `Verdict.evidence` is kept as a derived view.
- `Evidence.for_id` is deprecated: it returns cases declaring the id and is not used by verdicts. `Evidence.target_status` is kept but unused.
- `JUnitWriter.cases` becomes a read-only tuple; `_Case.requirements` is a read-only alias.

Statuses and gaps:
- New INCOMPLETE and INVALID statuses, with counts `requirements_incomplete` and `requirements_invalid`.
- `untraced-failure` is still emitted alongside `unattributed-failure` for 0.3.x.
- Consumers that switch on status must handle the new values: the CI step summary, traceability_site.py (it only copies and links), the editor, and any dashboard.

Report:
- `schema` becomes `rules_requirements/report/v2`. `evidence[]` and the old summary keys are kept for 0.3.x; `kind: "target"` refs are gone.

Exit codes: 0, 1 and 2 are unchanged; 3 is new.

Hooks:
- gtest records `requirement`; ingest reads both names.
- Rust trace lines use `requirement`; the old list form is still parsed, and a list with more than one id is quarantined.
- pytest writes only the nearest scope's id.
- The RR-E102 guard can turn a test that uses a raw `record_property("requirement")` red, which is the intended effect.

Modes: `attribution: hybrid` is the default, so existing tag-based projects keep their attribution except for multi-tags and shared targets.

Bazel: additive only. `rr_model(lock)`, `rr_report(check, lane, on_attribution_error)`, `rr_sets_lock_test`, `rr_wrapped_test(format = "junit")` are new; existing macros are unchanged.

v0.4.0: STRICT
- `attribution: model` is the default; hybrid warns `hybrid-mode`.
- Multi-id authoring fails at compile, import or collection time.
- Removed: the `TestCase.requirements` alias, `evidence[]`, `untraced-failure`, CheckPlan's v0.2 compatibility code.
- `bare-target-reference` and `multi-verifies-annotation` default to error.

Projects already on model mode (splanc after S7) need no changes.

## risks_and_open_questions

RISKS
1. **Honest verdict drop and lane INCOMPLETE noise.** Requirements whose sets span lanes never complete in a single lane report. The combined report depends on matching HITL and software evidence, and HITL runs lag main, so HITL evidence from another commit reads stale and the set is UNDER-VERIFIED. This is intended; the site banner and the RDD doc must explain it.
2. **Selector and lock churn.** Renames break literal selectors and lock entries. They surface as `missing-case` with the nearest-name hint and as a lock diff, never as a silent drop. This is real maintenance cost; it is also the change-control signal reviewers need.
   - HITL lock entries can only be refreshed from HITL artifacts. Literal HITL selectors keep this rare.
3. **Node event model.** The reporter relies on event ordering (diagnostics after pass, `details.type`, root-hook failures without test:start). This was verified on Node 22.22.0. Mitigations:
   - the conformance fixtures across Node 20, 22 and 24;
   - a runner fallback to the synthetic result on Node < 20;
   - diagnostics are cross-checks only, so a regression cannot mis-attribute.
4. **Synthetic detection** relies on Bazel's generate-xml.sh fingerprint (the "Generated test.log" system-out), which has been stable for years. Our own writers mark synthetic results explicitly. A misdetection could only turn pattern members into `missing`, which fails safe.
5. **Same-code coverage is not total.** It is automatic for per-case evidence with a source file (`rr.file`). For synthetic-only targets it needs a `variants` declaration. Undeclared variants with synthetic results stay a documented residual, closed by moving those harnesses to JUnitWriter/CheckPlan.
   - A libtest crate compiled into two targets has no file identity, so it only gets the `same-path-multiple-owners` warning.
6. **Static exactness holds only for the `*`-only grammar.** Keep the grammar closed. Report-time attribution covers any static blind spot, because it works on concrete keys (fuzz-checked).
7. **Label normalization** strips canonical `~`/`+` decorations for module repos only. Test targets in extension repos would need an explicit alias; splanc has none.
8. **Fork-per-case in `rr_case.h`** is POSIX only. On Windows it runs in-process and a failing assert ends the binary, so Bazel reports the target. `assert` vanishes under NDEBUG, so `RR_CHECK` is offered.
9. **A strict flaky default** (`under-verify`) may mark retry-recovered HITL results UNDER-VERIFIED. Rig trouble is recorded as skipped and does not count, but uninstrumented HITL scripts cannot tell rig from device.
10. **Migration effort and concurrency.** There are about 25 ownership decisions; S7 needs post-S5 HITL evidence; and the gap-closing agent edits requirements.yaml concurrently (S0 rules; rebase after S6/S7).

OPEN QUESTIONS FOR THE OWNER
1. Flaky policy: `under-verify` (proposed default) or `flag` for HITL? Should it be configurable per level?
2. `parent-with-claims`: warning (proposed) or error, i.e. pure decomposition, where a requirement with refining children is verified only through them? splanc has no `refines` today.
3. Should INCOMPLETE gate anything? Proposed: no gate in lane reports; the combined report is informational until the owner decides.
4. Confirm the Part C ownership proposals and HITL check owners. Which new assertions should be written for PR-21, PR-26 and PR-29, or should they read UNVERIFIED at hitl until then?
5. Do the pi/hitl/tests harness unit tests verify product PRs, or PR-23/PR-36 (HITL infrastructure)?
6. After model mode, keep in-code tags as cross-checks (proposed), or strip them with `--strip-tags`?
7. Should the fx_bench and led_capture JIT variants share one owner (declared `variants`), or assert JIT-specific checks under distinct case names so they can verify a different PR?
8. Cases skipped in CI (hardware-dependent): assign `none`, or make them run in some lane?

STANDARDS (clause level only)
- IEC 62304 §5.1.1: the development plan addresses traceability between system requirements, software requirements, software system tests and risk control measures.
- IEC 62304 §5.2.6: software requirements are verified, including that they are traceable and testable.
- IEC 62304 §5.7: software system testing.
- ISO 13485 §7.3.6: design and development verification, with records.
- ISO 14971 §7.2: verification of risk control measures, already reflected in the MIT→PR model.

None of these mandates a one-to-one mapping from test cases to requirements. The one-owner rule is this project's stricter policy. Its value is that every verification record is unambiguous: one case's result is evidence for exactly one requirement, and change-impact analysis is exact. splanc should record the policy and its rationale in docs/requirements-driven-development.md (its software development plan), so the stricter-than-required rule is documented as deliberate.

