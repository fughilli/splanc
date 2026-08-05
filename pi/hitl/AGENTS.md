# HITL rig — agent guide

A **hardware-in-the-loop** bench: a Raspberry Pi with one or more ESP32-C6 DUTs
(the player firmware) wired over USB. Agents reserve one over Tailscale, get an
isolated container with the ESP toolbox, flash firmware, and read serial logs —
then release it for the next agent. A shared FIFO admits waiters to whichever DUT
frees first; each DUT runs its own container concurrently. You normally don't care
which DUT you get, but `hitl reserve --device <name>` pins a specific one (see
`hitl status` for the names).

This is what you use to run **end-to-end firmware tests on real hardware**.

## Connect

The rigs live on the tailnet tagged `tag:splanc-hitl`. From a claude-container
that's on the tailnet, the CLI finds them automatically — no server to set:

```sh
alias hitl="bazel run //pi/hitl/cmd/hitl:hitl --"   # the CLI (stdlib-only Go)
hitl pool                                       # every tagged rig + its queue
hitl status                                     # the rig a bare command would use
hitl reserve                                    # picks the shortest-queue rig
```

With `--server`/`$HITL_SERVER` unset, `hitl` runs `tailscale status`, takes every
node tagged `tag:splanc-hitl`, probes each one's queue, and picks the shortest
(idle rigs first) — so you never queue behind a busy rig while another sits free.
Overrides, highest precedence first:

- `--server URL` / `$HITL_SERVER` — pin one specific rig.
- `$HITL_SERVERS` — an explicit comma/space host list, used instead of discovery.
- `$HITL_TAG` — discover by a different tag (default `tag:splanc-hitl`).

(`nix run 'path:/workspace/pi/hitl#hitl' --` also works if you prefer nix.)

The first `hitl` call mints a dedicated key under `~/.config/hitl/` and enqueues
it; you never use your personal SSH identity.

## The core loop

```sh
# 1. Build a flash bundle (one self-describing tar: manifest + bins).
bazel build //firmware/player_app:esp32c6_flashbundle

# 2. Flash it and watch the board boot, in one command. This reserves the rig
#    (waiting in the FIFO queue if busy), flashes, resets into the app, streams
#    ~10s of serial, then releases.
hitl flash --monitor bazel-bin/firmware/player_app/esp32c6_flashbundle.tar

# 3. Or watch logs without re-flashing (e.g. after poking the device):
hitl monitor --reset --seconds 15               # --reset to catch boot logs

# 4. Interactive shell in the container (esptool, python+pyserial, picocom, the
#    passed-through /dev/ttyACM0):
hitl reserve                                    # drops you in; logout releases

# 5. BLE: scan for the DUT and introspect its GATT (drives the rig's Bluetooth
#    adapter from inside the container).
hitl ble scan --name "Led Widget"               # find the DUT's address
hitl ble gatt F0:F5:BD:2C:E6:86                 # dump its services/characteristics

# 6. JTAG: halt/inspect the RISC-V core over the C6's built-in USB-JTAG.
hitl jtag                                        # halt, print PC, reset-run
hitl jtag -- -c "init; reset halt; reg; shutdown"   # arbitrary openocd commands

# 7. GDB: openocd gdbserver + riscv gdb attached (interactive, or batch -ex).
hitl gdb --elf bazel-bin/firmware/player_app/player_app   # symbols + interactive
hitl gdb -- -batch -ex "monitor reset halt" -ex "bt"      # scripted
```

`--id <res>` reuses an existing reservation instead of making a new one;
`--keep` holds the reservation after the command (default is release-on-exit).

## A typical E2E test

```sh
bazel build //firmware/player_app:esp32c6_flashbundle
log=$(hitl flash --monitor --monitor-seconds 12 \
        bazel-bin/firmware/player_app/esp32c6_flashbundle.tar 2>&1)
echo "$log" | grep -q 'SPI_FAST_FLASH_BOOT'            || { echo "did not boot from flash"; exit 1; }
echo "$log" | grep -q '\[ble\] advertising'           || { echo "BLE never came up"; exit 1; }
echo "$log" | grep -q '\[wss\] TLS player on :443'     || { echo "WSS server missing"; exit 1; }
echo "PASS"
```

Assert on the serial log the firmware prints (identity, `[ble]`, `[wss]`,
`[player]` lines). Boot mode `SPI_FAST_FLASH_BOOT` means it ran the app;
`USB_BOOT` / `wait usb download` means the board is strapped into download mode
(see Hardware notes).

## What's in the container

`esptool` (+ `espefuse`/`espsecure`), `hitl-flash`, `hitl-monitor`, `python3`
with `pyserial`, `picocom`, `coreutils`, `openssh`. The DUT is `/dev/ttyACM0`
(a+rw). There is no `tar`/`grep` — use Python if you need them in-container.

- `hitl-flash <bundle.tar> [--monitor] [--port DEV]` — flash from a bundle;
  offsets come from the bundle's `flash.json`, esptool v4/v5 syntax auto-picked.
- `hitl-monitor [--reset] [--seconds N] [--port DEV]` — serial reader that
  reopens on disconnect, so it survives the native-USB reset re-enumeration and
  captures boot logs.

ImprovBLE onboarding isn't a baked tool: the `//pi/hitl/harness:e2e` suite ships
its own provisioner (`pi/hitl/harness/hitl_improv.py`) into the reservation and
runs it with the container's `python3` (which has `bleak`), so the test doesn't
depend on the image being redeployed in lockstep with the harness.

The DUT is provisioned onto the **rig's own AP**, not an external network: the rig
runs a `hitl-<hostname>` AP on its onboard radio (concurrent with its STA uplink),
brought up per-reservation, and the daemon serves its creds — `hitl wifi` prints
`ssid=`/`psk=`, which the e2e uses automatically (no `--wifi-ssid` needed).

## Hardware notes

- **Boot strapping:** the C6's native USB-Serial-JTAG resets don't override the
  GPIO9/BOOT strapping pin. If every reset lands in `USB_BOOT` / `wait usb
download`, the BOOT button is held/stuck — this needs a human to release it and
  tap RESET. Report it in the issue; agents can't fix it.
- **Console:** the firmware logs over USB-Serial-JTAG (the same `/dev/ttyACM0`
  used to flash) — no separate UART bridge needed.
- **Enumeration:** if `/dev/ttyACM0` is missing in the container, the board isn't
  on the host USB (unplugged / bad USB state) — also a human fix.

## Etiquette

- Hold the rig only while you need it. The default release-on-exit is correct;
  reach for `--keep` only across a multi-step interaction, and release when done
  (`hitl release <id>`).
- The lease is heartbeated while a `hitl` command runs; if your process dies the
  lease expires and the next agent is promoted.

## USBIP (remote attach)

The rig host can export the C6 over the tailnet so a remote machine attaches it as
a local USB device (no `hitl` wrapper yet — run on the rig host):

```sh
usbipd -D && usbip bind -b 1-2      # export; `usbip unbind -b 1-2` to restore
# on your machine: usbip attach -r hitl-rig -b 1-2
```

Note this detaches the device from the rig (its serial tty disappears there) until
unbound, so it conflicts with reservations using the DUT.
