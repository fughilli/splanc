---
name: hitl
description: Reserve and drive the HITL rigs to run firmware tests on real ESP32-C6 hardware — flash a bundle, read serial logs, and use BLE/JTAG/GDB on a physical DUT. Use whenever asked to "run the HITL tests" / "run all HITL tests" (runs the exact bazel query + bazel test the CI HITL lane runs), when a change needs verifying on a real board (not just the simulator or unit tests), when asked to flash/monitor/debug firmware on the bench, or to reserve a rig. The rigs are Raspberry Pis with ESP32-C6 DUTs, reachable over Tailscale as reservable containers.
---

# HITL rig

Hardware-in-the-loop bench: a Raspberry Pi with one or more ESP32-C6 DUTs wired
over USB, exposed over Tailscale as reservable, isolated containers with a full
ESP toolbox. **This is how you run end-to-end firmware tests on real hardware.**

Reserve → the daemon spins up a container with the board attached and your key
authorized → flash / serial / BLE / JTAG / GDB → release (the container is torn
down; state never leaks to the next holder). Full docs live in the repo:
`pi/hitl/AGENTS.md` (agent guide), `pi/hitl/README.md`, `pi/hitl/DESIGN.md`.

## Run all HITL tests (what "run the HITL tests" means)

Run the **exact** thing the `HITL tests` CI lane runs (`.github/workflows/hitl.yaml`):
discover every `hitl`-tagged test with a bazel query, then `bazel test` the set.
The lane is **not a maintained list** — the targets are the `py_test`s tagged
`["manual","hitl"]` under `//pi/hitl/harness` that the query returns (run it to
see the current set); each reserves a free rig from the pool, flashes it,
ImprovBLE-provisions onto the rig's own AP, and exercises its slice over the
player WebSocket. Authoring a new one: `pi/hitl/AGENTS.md` "Adding an on-hardware
test".

```sh
targets=$(bazel query 'attr(tags, "\bhitl\b", tests(//...))')
echo "collected HITL tests:"; echo "$targets"
[ -z "$targets" ] && { echo "no HITL-tagged tests found"; exit 1; }
bazel test $targets \
  -c opt \
  --experimental_worker_for_repo_fetching=off \
  --loading_phase_threads=1 \
  --disk_cache="$HOME/.cache/bazel-disk" \
  --test_output=streamed \
  --test_env=HITL_SERVERS \
  --test_env=HITL_WIFI_SSID \
  --test_env=HITL_WIFI_PASS \
  --test_env=HITL_OWNER
```

Every flag matters — don't drop them:
- `-c opt` — match the firmware CI build.
- `--experimental_worker_for_repo_fetching=off` + `--loading_phase_threads=1` —
  serialize the flash-bundle's Nix toolchain realization (concurrent `nix build`s
  otherwise collide on the store's SQLite lock: `database … is busy`). FUG-84.
- `--test_output=streamed` — one at a time with live output; the shared bench
  can't take parallel reservations.
- `--test_env=…` — tests get a hermetic env, so forward the HITL knobs explicitly.
- `timeout=eternal` on the targets covers the multi-minute flash+provision.

If `tests(//...)` fails to parse on an *unrelated* stale path (e.g.
`web/ios/App/build/Logs/Build … No such file or directory` — a local iOS build
artifact churning mid-query; never happens on CI's fresh checkout), narrow the
universe to `tests(//pi/...)`. It returns the identical HITL set — every
`hitl`-tagged test lives under `//pi/hitl/harness` — without walking the whole
tree:

```sh
targets=$(bazel query 'attr(tags, "\bhitl\b", tests(//pi/...))')
```

**Preconditions:** the container must be on the tailnet with a live rig + board
reachable. Rig selection works via tag discovery (`tag:splanc-hitl`) with no env,
but to mirror CI exactly export the pool first — `export HITL_SERVERS="hitl-rig-1,
hitl-rig-2"` (or a single `100.x` IP). `HITL_WIFI_*` are optional overrides; unset,
the DUT provisions onto the rig's own AP. To pin one rig, add
`--test_arg=--server=<url>` (all targets accept it). The pure-logic units
(`//pi/hitl/tests:hitl_test`) are *not* in this set — they run in the normal
`bazel test //...` lane.

## The CLI

```sh
alias hitl="bazel run //pi/hitl/cmd/hitl:hitl --"   # stdlib-only Go CLI
# nix run 'path:/workspace/pi/hitl#hitl' -- …       # equivalent if you prefer nix
```

The first `hitl` call mints a dedicated key under `~/.config/hitl/` and enqueues
it — you never use your personal SSH identity.

**Rig selection is automatic.** With `--server`/`$HITL_SERVER` unset, `hitl` runs
`tailscale status`, takes every node tagged `tag:splanc-hitl`, probes each queue,
and picks the shortest (idle first) — so you never queue behind a busy rig while
another sits free. Overrides, highest precedence first:

- `--server URL` / `$HITL_SERVER` — pin one specific rig.
- `$HITL_SERVERS` — explicit comma/space host list, used instead of discovery.
- `$HITL_TAG` — discover by a different tag (default `tag:splanc-hitl`).

Requires the claude-container to be on the tailnet. Falls back to
`http://hitl-rig:8087` when nothing is discoverable.

## The core loop

```sh
# 1. Build a flash bundle (one self-describing tar: manifest + bins).
bazel build //firmware/player_app:esp32c6_flashbundle

# 2. Flash + watch boot, one command: reserves (FIFO-queues if busy), flashes,
#    resets into the app, streams ~10s of serial, releases.
hitl flash --monitor bazel-bin/firmware/player_app/esp32c6_flashbundle.tar

# 3. Watch logs without re-flashing (--reset to catch boot logs):
hitl monitor --reset --seconds 15

# 4. Interactive shell in the container (esptool, python+pyserial, picocom,
#    the passed-through /dev/ttyACM0); logout releases:
hitl reserve

# 5. BLE — drive the rig's Bluetooth adapter from inside the container:
hitl ble scan --name "Led Widget"        # find the DUT's address
hitl ble gatt F0:F5:BD:2C:E6:86          # dump services/characteristics

# 6. JTAG — halt/inspect the RISC-V core over the C6's built-in USB-JTAG:
hitl jtag                                # halt, print PC, reset-run
hitl jtag -- -c "init; reset halt; reg; shutdown"   # arbitrary openocd

# 7. GDB — openocd gdbserver + riscv gdb attached:
hitl gdb --elf bazel-bin/firmware/player_app/player_app   # symbols, interactive
hitl gdb -- -batch -ex "monitor reset halt" -ex "bt"      # scripted
```

## Command reference

```
hitl reserve [--owner ID] [--server URL] [--key PUBKEY] [--device NAME] [--keep] [--no-shell]
hitl status  [--server URL]                       # per-DUT queue / active holders
hitl pool    [--server-list LIST] [--tag TAG]     # status of every rig in the pool
hitl wifi    [--server URL]                        # the rig's provisioning-AP ssid/psk
hitl release <id> [--server URL]
hitl ssh     <id> [--server URL]
hitl flash   [--port DEV] [--id RES] [--keep] [--monitor] <bundle.tar>
hitl monitor [--port DEV] [--id RES] [--keep] [--reset] [--seconds N]
hitl ble     scan [--name S] [--seconds N] | gatt <address>   [--id RES] [--keep]
hitl jtag    [--id RES] [--keep] [-- openocd args]
hitl gdb     [--elf FILE] [--id RES] [--keep] [-- gdb args]
hitl run     [--id RES] [--keep] [--tty] -- <command...>       # run in the reservation
hitl cp      [--id RES] [--keep] <local...> <remote-dir>       # copy files in
hitl forward [--id RES] [--keep] [--local-port N] <host> <port>  # ssh -L via the rig
```

Cross-cutting flags: `--id <res>` reuses an existing reservation instead of making
a new one; `--keep` holds the reservation after the command (default is
release-on-exit). `--device <name>` pins a specific DUT (names come from
`hitl status`) — you normally don't care which you get.

## A typical E2E assertion

Assert on the serial log the firmware prints (identity, `[ble]`, `[wss]`,
`[player]` lines):

```sh
bazel build //firmware/player_app:esp32c6_flashbundle
log=$(hitl flash --monitor \
        bazel-bin/firmware/player_app/esp32c6_flashbundle.tar 2>&1)
echo "$log" | grep -q 'SPI_FAST_FLASH_BOOT'        || { echo "did not boot from flash"; exit 1; }
echo "$log" | grep -q '\[ble\] advertising'        || { echo "BLE never came up";      exit 1; }
echo "$log" | grep -q '\[wss\] TLS player on :443' || { echo "WSS server missing";     exit 1; }
echo PASS
```

Boot mode `SPI_FAST_FLASH_BOOT` = it ran the app. `USB_BOOT` / `wait usb
download` = the board is strapped into download mode (see Hardware gotchas).

There's also a maintained Python e2e driver that shells out to this same CLI —
`bazel run //pi/hitl/harness:e2e -- --bundle <bundle.tar>` — which does
reserve → flash → ImprovBLE provision → ws. It fetches AP creds via `hitl wifi`,
so it needs no nearby network. Prefer it for the full onboarding path.

## What's in the container

`esptool` (+`espefuse`/`espsecure`), `hitl-flash`, `hitl-monitor`, `python3` with
`pyserial` (and `bleak`), `picocom`, `openssh`. The DUT is `/dev/ttyACM0`.
**No `tar`/`grep` in-container** — use Python if you need them. WiFi provisioning
uses the rig's *own* AP (`hitl-<hostname>`), not an external network; `hitl wifi`
prints its `ssid=`/`psk=`.

## Hardware gotchas (a human must fix these — report in the issue)

- **Stuck in `USB_BOOT` / `wait usb download` on every reset:** the GPIO9/BOOT
  strapping pin is held/stuck. The C6's USB-JTAG reset can't override it. Needs a
  human to release BOOT and tap RESET.
- **`/dev/ttyACM0` missing in the container:** the board isn't on host USB
  (unplugged / bad USB state).

Agents can't fix either — surface it, don't retry blindly.

## Etiquette

- Hold the rig only while you need it. Default release-on-exit is correct; use
  `--keep` only across a multi-step interaction, then `hitl release <id>`.
- The lease is heartbeated while a `hitl` command runs; if your process dies the
  lease expires and the next waiter is promoted.
