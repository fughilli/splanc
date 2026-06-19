# Runbook

Operational steps for building, testing, and deploying LED Mapper. The durable
design lives in [`led-mapper-design.md`](../led-mapper-design.md); version
rationale lives in [`decisions.md`](./decisions.md).

## Prerequisites

| Tool | Version | Why |
| ---- | ------- | --- |
| [Bazelisk](https://github.com/bazelbuild/bazelisk) | any (pins Bazel via `.bazelversion` → 7.7.1) | The only build entry point. Invoke as `bazelisk`. |
| pnpm | 11+ | TypeScript workspace (`web/`, `shared/protocol/ts/`). |
| Node | 20+ | Runs `tsc` / the web toolchain. |
| Nix | (only for M4) | Building/deploying the Pi image. See `pi/provisioning/README.md`. Not needed for the rest of the build. |

A hermetic Python 3.11 and TypeScript come from Bazel; you do **not** need a
system Python or a global `tsc` for `bazelisk` builds.

## Bootstrap

```sh
bazelisk build //...        # build every target
bazelisk test  //...        # run every test
```

Scoped equivalents while iterating:

```sh
bazelisk test //shared/protocol:roundtrip_test          # M10 wire-protocol acceptance
bazelisk test //shared/protocol/ts:protocol_ts_typecheck_test   # generated TS type-checks
bazelisk build //shared/protocol:codegen_freshness      # fail if generated bindings drift
bazelisk test //pi/reconstruction:reconstruct_test      # M3 unit + solver tests
bazelisk test //shared/simulator:sim_recon_roundtrip_test   # M9→M3 Phase-2 acceptance
```

## The wire protocol (M10)

The JSON Schemas under `shared/protocol/schemas/*.json` are the single source of
truth. The Pydantic models (`python/ledmapper_protocol/_generated.py`) and the
TypeScript types (`ts/generated/index.ts`) are **generated from the schemas and
checked in** (so non-Bazel consumers — `tsc`, plain `python` imports — see them
on disk).

After editing a schema, regenerate the bindings:

```sh
python3 shared/protocol/codegen.py            # rewrites the two generated files
python3 shared/protocol/codegen.py --check    # CI/local: exit 1 if they're stale
```

`bazelisk build //shared/protocol:codegen_freshness` runs the `--check` form and
fails the build if you forgot to regenerate. Run the codegen with `python3`
directly (not `bazel run`) so it writes into the source tree rather than a
sandbox.

## Reconstruction (M3) from a session log

The Pi server (M2) persists a capture as a **detection log** — a JSON file of
the form `{ "ledCount": N, "detections": [ DetectionRecord, ... ] }` (each record
per design doc §7.4). Turn one into an output map (§7.5):

```sh
# Via the Bazel-built CLI (recommended; brings its own deps):
bazelisk run //pi/reconstruction:reconstruct -- /abs/path/session_log.json -o /abs/path/map.json

# Or directly with Python on the Pi:
PYTHONPATH=pi/reconstruction python3 -m reconstruction session_log.json -o map.json
```

Output is an `OutputMap` JSON; add `--csv map.csv` for the `id,x,y,z,confidence,n_views`
export. The CLI prints global stats (RMS reprojection px, median parallax,
solved/unmapped counts).

## Simulator (M9) — synthetic detection logs

Generate a deterministic detection log for a known fixture and virtual walk, with
no phone and no hardware (design doc §10.1). Defaults are the nominal-noise point
from [`decisions.md`](./decisions.md).

```sh
# Zero-noise line fixture → log, then reconstruct and compare:
bazelisk run //shared/simulator:simulate -- \
    --fixture line --leds 64 --noise none --seed 0 -o /tmp/log.json
bazelisk run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json

# Fixtures: line | grid | cube | helix.  Noise: none | nominal  (or per-knob flags).
```

The `//shared/simulator:sim_recon_roundtrip_test` target wires these together
and asserts the Phase-2 acceptance (zero-noise → < 1 mm RMS).

## Updating dependencies

```sh
# Python: edit requirements.in, then regenerate the lockfile
bazelisk run //:requirements.update

# TypeScript/JS: edit the relevant package.json, then
pnpm install                 # updates pnpm-lock.yaml
```

Whenever a pinned version changes, update [`decisions.md`](./decisions.md) in the
same commit.

## Provisioning the Pi (M4)

Full details and the current UNVERIFIED list are in
[`pi/provisioning/README.md`](../pi/provisioning/README.md). In brief (requires
Nix on the build host):

```sh
bazelisk run //pi/provisioning:image_sd   -- --device /dev/sdX   # build + flash an SD image
bazelisk run //pi/provisioning:deploy_live -- ledmapper.local    # in-place nixos-rebuild switch
bazelisk run //pi/provisioning:keys        -- rotate             # rotate the deploy SSH key
```

The deploy SSH key pair lives gitignored under `pi/provisioning/secrets/` (or
`$LEDMAPPER_DEPLOY_KEY_DIR`); the public half is baked into the image's
`authorized_keys` for passwordless first-boot SSH.

## Hardware notes (fill in before bench testing — Phase 4)

> Per design doc §13: the fixture's LED power supply, level-shifting/logic wiring,
> and SPI pin map are out of software scope but **must** be specified here before
> the bench end-to-end run. TODO once Phase 1 (M1 LED driver) lands.
