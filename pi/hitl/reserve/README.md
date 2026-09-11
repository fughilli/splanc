# pi/hitl/reserve — the generalized reservation module, wired into splanc

This directory brings [`hitl-reserve`](https://github.com/fughilli/hitl-reserve)
— the generalized hardware reservation/queueing system extracted from this repo's
`pi/hitl` rig — back into splanc as a Bazel module (`@hitl_reserve`, pinned in the
root `MODULE.bazel`).

This is now the rig's reservation system: the old `cmd/hitl-managerd` daemon,
`cmd/hitl` CLI, and `internal/*` have been removed, and the nix deploy
(`nix/hitl-app.nix` → `hitl-reserved --catalog reserve/catalog.json`) builds and
runs `@hitl_reserve`. Same rig behavior, on a reusable, hardware-agnostic engine
other repos share. The harness (`harness/hitl_client.py`) drives the daemon's HTTP
API directly and does its own ssh/scp/tunnel plumbing (splanc-specific, kept out of
the general CLI).

## Run

```bash
# Daemon (on a rig):
bazel run //pi/hitl/reserve:hitl-reserved -- \
  --catalog $(bazel info workspace)/pi/hitl/reserve/catalog.json \
  --host "$(hostname)" --workspace splanc --image hitl-test:latest

# Client:
export HITL_HOSTS="hitl-rig-1,hitl-rig-2,hitl-rig-3,amd-rig"
bazel run //pi/hitl/reserve:hitl -- status
bazel run //pi/hitl/reserve:hitl -- reserve --type esp32c6 -- ./run-test.sh
bazel run //pi/hitl/reserve:hitl -- reserve --unit led-mapper-pi-1   # the pin-only Pi
bazel run //pi/hitl/reserve:hitl -- reserve --type esp32c6+hackrf -- ./sdr-re.sh  # amd-rig composite
```

[`catalog.json`](catalog.json) expresses the splanc **Pi fleet** in the new schema;
set the Pi's real address and per-rig `--host`/`--workspace` at deploy.

### amd-rig — the SDR bench ([`catalog-sdr.json`](catalog-sdr.json))

`amd-rig` is an x86_64 mini-PC (deployed by `//pi/hitl:hitl_sdr`, an `amd64-generic`
board variant of the same flake — see the `pi/hitl/BUILD.bazel` header). It offers
**one composite reservable unit**, `c6-sdr` (type `esp32c6+hackrf`): an ESP32-C6
wired next to a HackRF One, handed out **together as a single atomic reservation**
for reverse-engineering the ESP32's lower-layer WiFi/BT stacks. The reservation
environment carries the ESP32 toolbox **and** an SDR toolbox (`hackrf_info`/
`hackrf_transfer`/`hackrf_sweep` + GNU Radio with gr-osmosdr, plus `gnuradio-python`
for flowgraphs — see `nix/container.nix` `withSdr`). Reserve it with `--type
esp32c6+hackrf` (or `--unit c6-sdr`); the daemon runs the environment privileged
(single-unit bench) so it reaches both the C6's tty/USB-JTAG and the tty-less
HackRF's raw USB.

## Concept mapping (pi/hitl → hitl-reserve)

| pi/hitl (managerd)                                      | hitl-reserve                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| DUT (a board, or a network DUT)                         | **unit** — now composable from ≥1 **component** (e.g. a C6 + a HackRF reserved together) |
| SKU (`skus.bzl`)                                        | **resource type** (component capabilities) + **unit type** (reservation target)          |
| `runner.Device` (name, kind, sku, devices, env)         | **component** (+ unit bundles several)                                                   |
| network DUT is pin-only (kind=="network")               | `pin_only` unit (explicit, not kind-inferred)                                            |
| logic analyzer broker (`internal/analyzer`, `/capture`) | **shared resource** (`shared.Broker`), generic `POST /shared/{name}`                     |
| `logic-analyzer-*` caps from the channel map            | shared-resource **binding** caps + live discovery `TapCaps`                              |
| `--discover` by-id USB monitor                          | `discovery` block in the catalog                                                         |
| pool over `$HITL_SERVERS`                               | pool over `$HITL_HOSTS`                                                                  |
| metrics labeled `rig`                                   | metrics labeled `host` **and** `workspace` (multi-repo dashboards)                       |
| `--dut '{…}'` flags / seeded network-DUT file           | declarative `catalog.json` (+ optional discovery)                                        |

## What still lives in `pi/hitl` (not generalized)

The ESP-specific extras that don't generalize stay on the managerd path for now:
per-reservation BLE/HCI (btmon) capture, the NetworkManager provisioning-AP
controller (hitl-reserve exposes a generic `engine.Hook` to reattach this), the
flash/monitor/ble/jtag/gdb toolbox subcommands, and the FX2 WS2812 `.sr`
reset-synthesis decode fix (`FUG-140`). Migrating those onto hitl-reserve
(as a custom runner image + shared-resource brokers + Hook) is the follow-up.

## Co-developing hitl-reserve locally

```bash
bazel run //pi/hitl/reserve:hitl-reserved \
  --override_module=hitl_reserve=/path/to/hitl-reserve -- --catalog …
```

Re-pin the `git_override` commit in the root `MODULE.bazel` when hitl-reserve
changes (and to its `main` SHA once its import PR merges).
