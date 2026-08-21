# WORKLOG — algorithmic PnR (branch `pnr-system`)

Handoff notes and build log, newest first — read the top entry to orient, then
scan back. Full design + rationale lives in
[`docs/hardware/pnr-system.md`](../../docs/hardware/pnr-system.md); this file is
the running state so a fresh-context agent can pick up cleanly. Update it at the
end of every session.

## 2026-08-21 — design doc drafted; no code yet (START HERE)

**State:** design/strategy is done; **no PnR code exists**. Next actor starts at
Task 0 → Phase 1 in `docs/hardware/pnr-system.md` §9/§11.

- **What exists:** the design doc (problem space, cited SOTA survey, architecture,
  phased plan with acceptance tests, handoff/bootstrapping). The two boards
  (`//hardware/splanc_dev`, `//hardware/splanc_eol_tester`) build a resolved
  `.kicad_pcb` (row placement + ratsnest) — the ingestion input for this system.
- **What does NOT exist:** `hardware/pnr/` code (only this WORKLOG), the
  `constraints.yaml` fixtures, the `atopile_pnr` / `<board>.fab` rule.
- **Chosen architecture (don't re-litigate — see doc):** differentiable
  graph-relaxation placement (DREAMPlace/**Cypress**-style: LSE wirelength +
  per-side density + net-crossing routability, Gumbel-Softmax orientation) →
  FastRoute/FLUTE lookahead global route → place↔route feedback made convergent
  with a **PathFinder-style history term** (region inflation à la RePlAce) →
  FreeRouting detailed route → DRC → fab export via the existing kicad-cli
  exporters. Python + PyTorch (CPU-first). No RL / no learned router.

**Blockers to clear first (Task 0, doc §9/§11):**

1. **Cypress license** — confirm NVlabs/Cypress permits vendoring/forking as our
   placement base; if not, plan a clean-room reimpl of its math. Record the
   verdict here.
2. **PyTorch under Bazel** — add `torch` (CPU wheel) to `//requirements.in`,
   `bazel run //:requirements.update`, prove `import torch` in
   `//hardware/pnr:torch_smoke_test`. Record any wheel/platform gotchas here.

**First vertical slice (Phase 1):** `hardware/pnr/pnr/ingest.py` loads a fixture
`.kicad_pcb` via pcbnew (the `@kicad_python` interpreter, see `//hardware/atopile`)
and prints component/net/pad counts + `--dump-svg`; `constraints.py` parses the
example `constraints.yaml`. Green `ingest_test`.

**Environment reminders (full list in doc §11):** build with
`bazelisk --output_base=$HOME/.cache/bazel-atopile build //hardware/...` (the
`/workspace` mount is macOS-synced); pip = root `requirements.in` + `@pypi`;
prek hooks can abort commits (re-add + re-commit); don't push from the container.
