# PnR guidance inputs — the constraint language

The algorithmic place-and-route system (FUG-138, design:
[`pnr-system.md`](pnr-system.md)) is **constraint-first**: its value is honoring
your mechanical and electrical _intent_ — connectors on a particular edge, an
antenna keep-out, a button reachable from the enclosure, decouplers on the back —
not just minimizing wirelength. You express that intent in a **sidecar
`constraints.yaml`** next to the board; nothing in the `.ato` changes.

This document is the reference for that file: every section, what it means, and
how it steers placement. For the algorithms behind it see the design doc; for a
working example see
[`hardware/splanc_dev/constraints.yaml`](../../hardware/splanc_dev/constraints.yaml).

## Where it plugs in

```text
bazel build //hardware/splanc_dev:splanc_dev.fab
    ├─ atopile resolves the .ato        →  row-placed .kicad_pcb (netlist + footprints)
    ├─ constraints.yaml  ───────────────┐
    │                                   ▼
    ├─ ingest → place+route loop  (honors the constraints below)
    ├─ writeback → detailed route (FreeRouting)
    └─ DRC + export               →  Gerbers / drill / BOM / pick-place
```

The board target names the file:

```python
atopile_pnr(
    name = "splanc_dev.fab",
    layout = ":splanc_dev",          # the atopile_project base target
    constraints = "constraints.yaml",
)
```

## Coordinate frame and units

- **Units:** millimetres everywhere; `rot` is **degrees CCW**.
- **Origin:** the board-outline **bottom-left** corner. `x` grows right, `y`
  grows up. (KiCad's own y grows _down_; ingest/writeback convert for you.)
- **Edges** are named by compass direction: `south` = `y=0`, `north` = `y=H`,
  `west` = `x=0`, `east` = `x=W`.

## Hard vs. soft

Every constraint compiles to one of two things (design §3):

- **Hard** — a feasibility barrier the result must satisfy: fixed poses,
  keep-outs, the outline. Violations are illegal, and the acceptance tests fail.
- **Soft** — a weighted penalty expressing a preference: edge pulls, side bias,
  grouping. The optimizer trades these off against wirelength; a higher `weight`
  makes the preference stronger. Soft constraints are _intent_, not guarantees.

## The file

```yaml
schema: v0 # required; the schema is versioned so it can grow

board: # global: approximate size + design rules
  outline: { w: 60, h: 50 }
  layers: 4
  default_clearance_mm: 0.3

fixed: # hard: pin a part's pose
  USB1: { edge: south, align: center, rot: 0, side: top }
  U5: { edge: north, align: center, rot: 0, side: top }

edge_align: # soft: pull a part to a board edge
  SW1: { edge: south, side: top }
  CN1: { edge: east, side: top }

keepout: # hard: no parts/copper in a region
  - { name: esp32_antenna, ref: U5, extent: { edge: north, depth_mm: 6 } }

side_pref: # soft: bias a set of parts to a side
  bottom: [C*, R*]

group: # soft: cluster parts near an anchor
  - { members: [U2, L2, L3], anchor: U2, radius_mm: 8 }
```

Unknown component references are **warnings, not errors** (the file can name a
part that a build variant drops), and globs (`C*`, `R?`, `U[13]`) expand against
the real netlist. Unknown top-level sections are ignored with a warning, so a
newer schema stays readable by an older engine.

### `board` — size and rules

The approximate board you're targeting.

| Key                    | Meaning                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `outline: {w, h}`      | Placement region (mm). Parts are kept inside it; it becomes the `Edge.Cuts` rectangle. Omit to use the board's own outline.       |
| `layers`               | Copper layer count (2/4). Inner layers are treated as power/ground planes, so routing capacity scales with the **signal** layers. |
| `default_clearance_mm` | Minimum courtyard-to-courtyard gap enforced in legalization, and the track pitch the lookahead router assumes.                    |

The outline is _approximate guidance_: the placer frames the parts within it. Make
it a bit larger than the parts need — an over-tight outline forces congestion and
can leave the place↔route loop unable to reach zero overflow.

### `fixed` — lock a pose (hard)

Pins a part so downstream steps can't move it — the right tool for anything with a
mechanical interface (a USB connector that must protrude, a module whose antenna
must point off-board). Fixed parts are held out of the position gradient but still
pull their nets (so nearby parts cluster around them).

| Key     | Meaning                                                                               |
| ------- | ------------------------------------------------------------------------------------- |
| `edge`  | Sit flush against `north`/`south`/`east`/`west`.                                      |
| `align` | Position along the free axis: `left`/`right`/`center` (default center).               |
| `at`    | Explicit `[x, y]` centre (mm). Overrides `edge`/`align` when you know the exact spot. |
| `rot`   | Orientation (degrees CCW); snapped to 0/90/180/270.                                   |
| `side`  | `top` or `bottom`.                                                                    |

### `edge_align` — pull to an edge (soft)

Attracts a part toward a board edge without nailing it there, and snaps its
orientation to that edge. Use for user-facing controls and edge connectors that
should be reachable but whose exact position the optimizer may choose.

| Key      | Meaning                                            |
| -------- | -------------------------------------------------- |
| `edge`   | Target edge (required).                            |
| `side`   | Preferred side (`top`/`bottom`).                   |
| `weight` | Penalty weight (default 5.0); higher pulls harder. |

### `keepout` — exclude a region (hard)

A region where no part (and, at detailed-route time, no copper) may go — antenna
clearance, a mounting-hole boss, a shield footprint. Two forms:

- **Relative to a part** — `ref` + `extent: {edge, depth_mm}`: a band `depth_mm`
  deep hanging off the named part's courtyard edge. Moves with that part, so an
  RF module's antenna clearance stays correct wherever the module ends up.
- **Absolute** — `polygon: [[x,y], ...]`: a fixed region in board coordinates
  (taken as its bounding box in v0).

Give each keep-out a `name` so warnings and reports are legible.

### `side_pref` — top/bottom bias (soft)

Biases a set of parts toward a side. The classic use is pushing decoupling caps
and passives to the back (`bottom`) to keep the top clean for the parts a user
sees or that need access. Keyed by side, valued by refs/globs.

```yaml
side_pref:
  bottom: [C*, R*] # all caps and resistors prefer the back
  top: [U*, J*] # ICs and connectors prefer the front
```

> Note: in the current MVP `side_pref` compiles to a soft term but legalization
> keeps parts on the top side (single-sided legalize); two-sided placement is a
> tracked follow-on. `fixed.side` is honored end-to-end.

### `group` — cluster a subsystem (soft)

Pulls members within `radius_mm` of an `anchor`, so a functional block (a
switching regulator and its inductor + caps, a crystal and its load caps) lands
together — shorter loops, less noise.

| Key         | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `members`   | Refs/globs to cluster.                             |
| `anchor`    | The ref they cluster around (usually the main IC). |
| `radius_mm` | Target radius (default ~5 mm).                     |
| `weight`    | Penalty weight (default 2.0).                      |

### `net_class` / `diff_pair` / `length_match` — routing rules

These describe how nets are _routed_ rather than how parts are _placed_ — they
drive the detailed router (trace widths) and the post-route **quality pass**
(`pnr/quality.py`), which measures routed length, via count, differential-pair
skew, and length-match compliance. They are keyed by **net name** (not component
ref); net-name globs (`*hv`) expand against the real netlist.

```yaml
net_class:
  power: { width_mm: 0.4, clearance_mm: 0.3, nets: [lv, '*hv', GND, '*-GND'] }

diff_pair:
  - { name: usb, p: USB_DP, n: USB_DM, width_mm: 0.2, gap_mm: 0.15, skew_mm: 0.3 }

length_match:
  - { name: rgmii, nets: [TXD0, TXD1, TXD2, TXD3], tolerance_mm: 1.0 }
```

- **`net_class`** — a named width/clearance rule over a set of nets. Applied to
  the board's net settings in write-back, so **FreeRouting routes those nets at
  the given width** (e.g. power rails wider). The quality report rolls up total
  routed length per class.
- **`diff_pair`** — two nets (`p`/`n`) routed together with `width_mm`/`gap_mm`;
  the quality pass reports their routed-length **skew** and flags it if it
  exceeds `skew_mm` (default 0.5).
- **`length_match`** — a group of nets whose routed lengths must agree within
  `tolerance_mm`; the quality pass reports the group **spread** and flags it if
  it exceeds the tolerance.

The quality report ships in the fab bundle as `quality.txt`. By default the
checks are **advisory** (reported, not enforced); set `quality_gate = True` on the
`atopile_pnr` target to fail the build when a diff-pair/length-match check fails
(as `drc_gate` does for DRC).

## How intent becomes a layout

1. **Ingest** reads the resolved board into a neutral graph (components, pads,
   nets, courtyards).
2. **Placement** (differentiable, design §4) minimizes smooth wirelength +
   spreading + your constraint penalties; `fixed`/`keepout`/outline are hard
   barriers, `edge_align`/`side_pref`/`group` are penalty gradients. Orientation
   is co-optimized (§9.3).
3. **Legalization** snaps to a strictly non-overlapping, in-outline layout that
   still honors the fixed poses and keep-outs.
4. **Place↔route loop** (design §6) global-routes the placement, and where copper
   demand exceeds capacity it inflates those parts' spacing and re-places — until
   the board is routable, then FreeRouting does the detailed route.

So: **hard** constraints define the feasible region; **soft** constraints shape
the objective within it; and wirelength + routability do the rest.

## Tips

- Start minimal — fix only the parts with a real mechanical interface, add one or
  two `group`s for the noisy subsystems, and let the optimizer do the rest. Then
  tighten with `edge_align`/`side_pref` if the result needs nudging.
- If the place↔route loop won't converge (overflow won't reach 0), the outline is
  probably too small or a keep-out too large — give it more room.
- Weights are relative; bump one `weight` up a few× to make that preference win
  against wirelength, rather than hand-placing.
- The result is a first-spin layout for an EE to review, not a substitute for
  one. Fixed poses and keep-outs are trustworthy; soft preferences are advisory.
