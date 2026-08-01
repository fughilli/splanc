# HITL rig

Hardware-in-the-loop test bench: a Raspberry Pi with an ESP32-C6 over USB,
exposed to agents (via issuefleet) as a reservable, containerized environment
over Tailscale. See [`DESIGN.md`](./DESIGN.md) for the architecture.

## For an agent

```sh
export HITL_SERVER=http://hitl-rig:8087      # the rig over the tailnet
nix run 'path:pi/hitl#hitl' -- reserve       # queue, then drop into an SSH shell on the rig
#   … flash / serial / gdb / ble … then exit the shell to auto-release
nix run 'path:pi/hitl#hitl' -- status
```

`hitl reserve` waits in a FIFO queue; at the head it gets a container with the
ESP32 attached and your key authorized, SSHes you in, heartbeats to hold the
lease, and releases on exit (`--keep` to hold it).

## Deploying the rig

```sh
bazel run //pi/hitl:hitl.keys        -- init
bazel run //pi/hitl:hitl.image_sd    -- --device /dev/diskN   # flash a card
bazel run //pi/hitl:hitl.deploy_live -- hitl-rig              # or push to a running rig
```

(On macOS, start the builder first: `bazel run @sbc_deploy//:linux_builder`.)

## Status — MVP scaffold

Working & verified here: the Go daemon + CLI (compile, vet), the reservation
queue / lease / API / CLI loop (smoke-tested with a stub Podman), the nix
package (`buildGoModule` builds both binaries), and the flake/Bazel targets
(image + deploy + the CLI package).

Not yet exercised on hardware (see DESIGN.md "Open items"): the real Podman
container + sshd bring-up, USBIP passthrough of the dev board, the JTAG/BLE/WiFi
toolbox layers, and the full Pi image build. MVP uses `--device` tty passthrough
of the ESP32 until USBIP is wired.

## Tests (FUG-33)

An end-to-end suite drives a **pool** of rigs (the checkout mechanism) and
checks ImprovBLE setup, rename, and time sync on a real board:

```sh
bazel test //pi/hitl/tests:hitl_test           # pure-logic units (codec/sync/pool)
export HITL_SERVERS="hitl-rig-1, hitl-rig-2"    # pool; free runner is auto-picked
bazel run  //pi/hitl/tests:e2e -- \
    --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar \
    --wifi-ssid BigVibes --wifi-pass SECRET     # reserve → flash → improv → ws
```

The suite is `tags = ["manual", "hitl"]`, so it stays out of `bazel test //...`
and gets its own lane: a dedicated `hitl-tests` CI job (in
`.github/workflows/test.yaml`) collects the `hitl`-tagged test targets with a
bazel query — `bazel test $(bazel query 'attr(tags, "\bhitl\b", tests(//...))')`
— and runs the pure-logic units so the Improv/sync/pool code can't drift.

`e2e` needs a live rig + board; it reserves a **free** rig from `$HITL_SERVERS`
(else `$HITL_SERVER`, else a specific `--server`), so it never queues behind a
busy one. Being a `py_binary` it's excluded from the `tests(...)` query; the
`.github/workflows/hitl.yaml` job runs it on demand, joining the tailnet with a
`TS_AUTHKEY` secret and reading the pool from `HITL_SERVERS` (that file's header
documents the `HITL` environment config).

## Layout

```text
pi/hitl/
  cmd/hitl-managerd/   # Pi-side reservation daemon (Go)
  cmd/hitl/            # agent CLI (Go)
  internal/{api,queue,runner,pool}/
  tests/               # e2e suite + pure-logic units (Python; FUG-33)
  nix/
    packages.nix       # buildGoModule -> bin/hitl{,-managerd}
    container.nix      # dockerTools test container (sshd + ESP toolbox)
    hitl-app.nix       # NixOS: podman, tailscale, usbip, the daemon
  flake.nix            # mkSbcProject + packages.<system>.hitl
  BUILD.bazel          # sbc_application(name = "hitl", …)
```
