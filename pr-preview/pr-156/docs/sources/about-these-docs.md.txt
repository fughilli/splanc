# How these docs are built

This whole site is generated from the repository by a **single Bazel target**:

```sh
bazel run //docs:build
```

That target (`docs/build_docs.py`) does two things, in order:

1. **Regenerates the figures and animations.** It runs the _real_ `shared/simulator`
   → `pi/reconstruction` code path (`docs/gen_figures.py`) to render the fixture
   gallery, the synthetic camera-walk animation, and the reconstruction-accuracy
   figure. Nothing is hand-drawn, so the visuals can't drift from the code.
2. **Builds the HTML.** It assembles a staging source tree that mirrors the repo
   layout — so the relative links between the existing markdown docs keep
   resolving — drops in the hand-written overview / architecture / subsystem
   pages and the generated figures, and runs Sphinx (MyST + furo).

The rendered site lands in `docs/site/html/` (open `index.html`). To preview it
over HTTP:

```sh
bazel run //docs:serve       # serves docs/site/html on http://localhost:8000
```

## What's hand-written vs folded in

- **Hand-written for the site** (`docs/_sphinx/`): the landing page, the
  {doc}`architecture` overview and its diagrams, and the {doc}`subsystem
<subsystems/index>` tour.
- **Folded in as-is**: `README.md`, `DEVELOPERS.md`, `EFFECTS.md`,
  `led-mapper-design.md`, everything under `docs/`, and the subsystem READMEs
  (`web/`, `solver/`, `tools/sim_studio/`). Editing those source files is all it
  takes to update the site — they are the same files the repo has always had.

## Toolchain

Sphinx, MyST-parser, the furo theme, `sphinx-copybutton`, `sphinx-design`,
`sphinxcontrib-mermaid`, and matplotlib — all pinned in `requirements.lock` and
recorded in {doc}`docs/decisions`. Add or bump them the usual way:

```sh
# edit requirements.in, then:
bazel run //:requirements.update
```

## Adding a page

Drop a markdown file under `docs/_sphinx/` (or add a subsystem page under
`docs/_sphinx/subsystems/`) and reference it from the nearest `toctree`. To
surface an existing repo doc, add it to a `toctree` in `index.md` or
`design/index.md` — the staging step already mirrors the repo, so `{doc}` and
`{include}` paths line up with the real tree.

To add a new **figure**, extend `docs/gen_figures.py` (it writes into the staged
`_generated/` directory) and reference the output from any page. It reruns on
every `bazel run //docs:build`.
