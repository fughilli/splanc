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

## The LED driver (M1)

The real-time driver process owns the SPI bus and the pattern clock, running the
Gray-code cycle and exposing a Unix-socket control plane for M2.

```sh
# On the Pi (real hardware):
bazelisk run //pi/led_driver:drive -- --socket /run/ledmapper/control.sock

# Hardware-free dry run (in-memory sink), lighting a 16-LED cycle:
bazelisk run //pi/led_driver:drive -- --dry-run --socket /tmp/control.sock --start 16
```

The control commands (`start`/`stop`/`get_clock`/`set_debug`) and the wire format
are documented in [`pi/led_driver/README.md`](../pi/led_driver/README.md). Real
cadence verification (±10% per §9 Phase 1) needs a logic analyzer on a bench and
is not covered by CI.

## The Pi server (M2)

The FastAPI/uvicorn server hosts the web app and the §7 WebSocket control plane,
persists a capture to a session log, runs reconstruction when the capture ends,
and serves the maps.

```sh
# Run locally on a high port (port 80 needs root):
bazelisk run //pi/server:serve -- \
    --host 127.0.0.1 --port 8080 \
    --session-dir /tmp/ledmapper/sessions --maps-dir /tmp/ledmapper/maps

curl -s http://127.0.0.1:8080/healthz            # {"status":"ok"}
curl -s http://127.0.0.1:8080/maps/<id>          # reconstructed OutputMap JSON
curl -s http://127.0.0.1:8080/maps/<id>.csv      # id,x,y,z,confidence,n_views
```

Endpoints and the full WebSocket message flow are documented in
[`pi/server/README.md`](../pi/server/README.md). The
`//pi/server:server_integration_test` target boots a real server and drives the
whole flow (hello → clock sync → start → detections → stop → reconstruct →
serve) using M9 simulator data — the §6 M2 acceptance.

## The web app (M5–M8) + phone testing against the virtual LED wall

`bazelisk run //web:serve` serves the built web app through M2 over **HTTPS**
(WebXR needs a secure context; self-signed cert persisted under
`.ledmapper/`). Open `/wall.html` fullscreen on a laptop — a flat grid of
virtual LEDs blinking the M1 Gray code against the server's pattern clock —
and run a capture from an Android phone pointed at the screen: the full live
pipeline with no LED hardware. The step-by-step runbook (ports, Chrome flags,
tuning query params) is in [`web/README.md`](../web/README.md).

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

## Sim Studio — interactive solver debugging

An interactive 3D tool to generate a fixture, fly a camera around to synthesize
captures, and watch the **real M3 solver** converge against ground truth (per-LED
error, parallax, reprojection RMS update live). It reuses M9 + the shared camera
model + M3, so it debugs the actual algorithm.

```sh
bazelisk run //tools/sim_studio:serve   # binds 0.0.0.0:8090 by default
# then open http://localhost:8090  (front-end loads Three.js from a CDN)
```

In `claude-container`, the overlay maps `127.0.0.1:8090:8090` (and `:8080` for
M2) to the host, so after a container **restart** `http://localhost:8090` works
from your host browser. The server must bind `0.0.0.0` (the studio default) for
the mapping to reach it.

New scene → orbit & *Capture* (or *Auto-arc*) → *Solve*; toggle auto-solve to
watch the fit tighten as coverage grows, and dial in pixel/pose/dropout noise to
stress the solver. Full guide in [`tools/sim_studio/README.md`](../tools/sim_studio/README.md).

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
