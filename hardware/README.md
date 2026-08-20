# hardware — PCBs as code (atopile)

FUG-131. Splanc hardware, designed with [atopile](https://atopile.io) and built
with [rules_atopile](https://github.com/fughilli/rules_atopile) (`ato` +
`kicad-cli`, Nix-pinned). Two boards:

| Board                                      | What                                                                                                                                                     | Design doc                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`splanc_dev/`](splanc_dev/)               | ESP32-C6 dev module: power (LiPo charge + fuel gauge + 5 V boost), 2× monitored/switched LED channels, IMU + baro sensors, USB-C, buttons, EoL connector | [docs/hardware/splanc-dev-module.md](../docs/hardware/splanc-dev-module.md) |
| [`splanc_eol_tester/`](splanc_eol_tester/) | End-of-Line test fixture: FX2 24 MHz logic analyzer, isolated button drivers, switchable resistive loads, rail/CSA sampling                              | [docs/hardware/splanc-eol-tester.md](../docs/hardware/splanc-eol-tester.md) |

## Build

```bash
bazel run //hardware/splanc_dev:build             # resolve + lay out -> .kicad_pcb
bazel run //hardware/splanc_dev:build -- pdf      # + layout PDF (kicad-cli)
bazel run //hardware/splanc_dev:build -- gerber   # + Gerbers + drill
# or directly:
hardware/tools/ato_build.sh hardware/splanc_dev [pcb|pdf|gerber]
```

`ato` builds **hermetically** — every part is a pre-picked atomic LCSC component
(`elec/src/parts/**` + `passives.ato`), so there is **no** picker / components
API / EasyEDA call at build time (`Picking parts [0.03s]`).

Requires `nix` (already a repo prerequisite) + `git`. The first build fetches
rules_atopile and realises its Nix `ato`/`kicad-cli` toolchain.

## Why it's not wired into `//MODULE.bazel`

rules_atopile was authored as a standalone **root** Bazel module. Its Nix
toolchain uses rules_nixpkgs `nix_repo`/`nix_pkg` extension tags that are
**root-module-only** — as a `bazel_dep` they fail (`Illegal use of the file/attr
tag`), and marking the extensions `isolate = True` gets past that only to hit a
rules_nixpkgs file-copy bug. So `ato_build.sh` drives rules_atopile at a pinned
commit through its own `nix develop` instead — the same `ato`/`kicad-cli` steps
the rules would run, without destabilising this repo's build graph. Wiring it as
a first-class `atopile_project()` is a follow-up (needs an upstream rules_atopile
change to compose as a dependency).

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
