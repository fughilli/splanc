# hardware — PCBs as code (atopile)

FUG-131. Splanc hardware, designed with [atopile](https://atopile.io) and built
with [rules_atopile](https://github.com/fughilli/rules_atopile) (`ato` +
`kicad-cli`, Nix-pinned). Two boards:

| Board                                      | What                                                                                                                                                     | Design doc                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`splanc_dev/`](splanc_dev/)               | ESP32-C6 dev module: power (LiPo charge + fuel gauge + 5 V boost), 2× monitored/switched LED channels, IMU + baro sensors, USB-C, buttons, EoL connector | [docs/hardware/splanc-dev-module.md](../docs/hardware/splanc-dev-module.md) |
| [`splanc_eol_tester/`](splanc_eol_tester/) | End-of-Line test fixture: FX2 24 MHz logic analyzer, isolated button drivers, switchable resistive loads, rail/CSA sampling                              | [docs/hardware/splanc-eol-tester.md](../docs/hardware/splanc-eol-tester.md) |

## Build

Each board is an `atopile_project` target (`//hardware/<board>:<board>`), which
fans out a family of sub-targets:

```bash
bazel build //hardware/splanc_dev:splanc_dev          # resolve + lay out -> .kicad_pcb
bazel build //hardware/splanc_dev:splanc_dev.pdf      # + layout PDF (kicad-cli)
bazel build //hardware/splanc_dev:splanc_dev.gerber   # + Gerbers + drill dir
bazel run   //hardware/splanc_dev:splanc_dev.view     # open the layout in KiCad
```

`ato` builds **hermetically** — every part is a pre-picked atomic LCSC component
(`elec/src/parts/**` + `passives.ato`), so the targets set `picker = False` and
there is **no** picker / components API / EasyEDA call at build time
(`Picking parts [0.03s]`). The `.pdf`/`.gerber` exports run `kicad-cli` on the
resolved `.kicad_pcb` with no network.

### Two layout paths: the autoroute _preview_ and the algorithmic PnR fab flow

The `.ato` sources are electrical-only, so `ato` auto-places parts in a naive
row. There are two ways to get from there to a laid-out board:

**1. Autoroute preview (`.pdf`/`.gerber`).** The base targets set
`outline_margin_mm = 4` (auto Edge.Cuts outline + tight page) and
`autoroute = True` (headless FreeRouting), bounded by `route_max_passes = 3` so a
build finishes in ~3 min instead of ~10. The result is framed and routed but the
placement is atopile's naive row, so the routing is long/dense — a **preview /
DRC aid, not a fab-ready layout**.

**2. Algorithmic place-and-route (`.fab`)** — FUG-138. `//hardware/splanc_dev:
splanc_dev.fab` runs the full multi-turn optimize loop: differentiable placement

- orientation, then the place↔route feedback loop, honoring the spatial guidance
  in `constraints.yaml` (connector/edge placement, antenna keep-outs, board size,
  side/grouping preferences). It writes the optimized placement back onto the
  board, routes it, runs DRC, and emits the vendor fab bundle (Gerbers + drill +
  BOM + pick-place). This replaces the naive-row preview with a real optimized
  layout while keeping the one-target UX. See `docs/hardware/pnr-system.md` (design)
  and `docs/hardware/pnr-inputs.md` (the constraint language), and
  `hardware/pnr/` (the engine).

```bash
bazel build //hardware/splanc_dev:splanc_dev.fab        # optimized board + fab bundle
bazel build //hardware/splanc_dev:splanc_dev.fab.board  # just the routed .kicad_pcb + DRC report
```

For production either flow's output is a first-spin an EE should review; fixed
poses and keep-outs are trustworthy, soft placement preferences are advisory. To
hand-finish, `bazel run //hardware/<board>:<board>.view`, save, commit the
`.kicad_pcb`, flip `frozen = True`.

Requires `nix` (already a repo prerequisite). The first build realises the
Nix `ato`/`kicad-cli` toolchain (see below); no `nix develop` shell needed —
Bazel provides the tools as action inputs.

## How the Nix toolchain is wired

rules_atopile provides the Starlark rules (`atopile_project`) and an
`atopile_toolchain` rule, but **not** the tools: its own Nix toolchain uses
rules_nixpkgs `nix_repo`/`nix_pkg` extension tags that are **root-module-only**,
so they can't run when rules_atopile is consumed as a `bazel_dep`. So the wiring
is split, the way rules_nixpkgs intends:

- `//MODULE.bazel` pulls rules_atopile via `git_override` (patched to a minimal,
  dependency-safe module — see `patches/rules_atopile-composable-dep.patch`) and
  builds `ato` + `kicad-cli` from **this repo's** Nix (`nix_pkg.file` over
  rules_atopile's `nix/packages.nix`, pinned to that project's nixpkgs so the
  `venvHash` matches — `patches/rules_atopile-venvhash.patch`).
- `//hardware/atopile` binds those `@atopile`/`@kicad` tools to an
  `atopile_toolchain` and registers it (per exec platform).

`ato_build.sh` (its own `nix develop` flow) predates this and is kept only for
part authoring (`gen_parts_robust.sh`, `sanitize_footprints.py`); the boards now
build through Bazel's toolchain.

## How the design is authored

atopile 0.15.x picks parts by `lcsc_id` against a components API. To stay
hermetic and offline we instead commit **atomic** parts (each carries a
`has_part_picked` trait — no pick needed) and connect them directly:

- **ICs / connectors** — a generated component per LCSC id under
  `elec/src/parts/<Mfr_Part>/` (the `.ato` interface + `.kicad_mod` footprint +
  `.kicad_sym` symbol). Import and wire by named signal.
- **Passives** — thin `pN`-terminal wrappers in `passives.ato` over the same
  atomic parts (so a resistor/cap reads as `R10k`/`C100n`, not a bare LCSC id).

3D `.step` models are intentionally **not** committed (large; only used for 3D
render, not for 2D fab). The parts' `is_atomic_part` `model=` attribute is
stripped, so the build needs no models.

### Tooling (`hardware/tools/`)

| Script                   | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `ato_build.sh`           | build a board via rules_atopile + nix (the `bazel run` entry)   |
| `picker_catalog.json`    | authoring-time LCSC catalog for the local picker                |
| `picker_server.py`       | the local picker (copy of rules_atopile's)                      |
| `gen_parts_robust.sh`    | `ato create part` for a list of LCSC ids (retries EasyEDA)      |
| `name_pins.py`           | add named `pN` signals to bare-pin generated parts (connectors) |
| `sanitize_footprints.py` | fix EasyEDA footprints that crash atopile's layout              |

To add a part: put its LCSC id in `picker_catalog.json`, run
`gen_parts_robust.sh <board-dir> <id>`, then `sanitize_footprints.py` the parts
dir, and (for a connector) `name_pins.py` the generated `.ato`.

### atopile 0.15.8 gotchas worked around here

- **venvHash drift** — the atopile uv-venv FOD hash for aarch64-linux drifts as
  transitive deps release; re-pinned via `patches/rules_atopile-venvhash.patch`.
- **`min() iterable argument is empty` at layout** — atopile's bbox routine
  reads only Lines/Rects, so an EasyEDA footprint whose silkscreen is _only_
  circles yields an empty bbox and crashes. `sanitize_footprints.py` adds a silk
  outline line (and drops zero-length lines). Run it on any newly generated part.

## Known simplifications (vs the design docs)

Documented inline in the `.ato` and in the design docs; all are first-spin
choices a human EE should review before fabrication:

- The dev module `.ato` uses the **ESP32-C6-WROOM-1 module** (proven RF); the doc
  keeps the discrete-chip + IFA + π-match as the specified variant (needs VNA
  tuning).
- **VSYS is USB-fed** (the battery charges but doesn't load-share) — see design
  doc §5.3.
- **Compass (QMC5883L) + mic (INMP441)** are left off the first spin (their LCSC
  footprints didn't resolve); pinned out for a follow-up.
- The LED-channel current **shunt is a 0 Ω stand-in** pending a 2512 footprint;
  the EoL **load-bank resistors** are 0402 stand-ins for the production power
  resistors. Values noted in the source.
- Regulator feedback / boost compensation values are first-pass; verify against
  the datasheets.
