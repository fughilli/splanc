# HITL rig — design

Hardware-in-the-loop test rig: a Raspberry Pi with an ESP32-C6 attached over
USB, exposed to agents (via issuefleet) as a reservable, containerized test
environment reachable over Tailscale.

## Goals

An agent in a claude-container session runs `hitl reserve`; it waits in a FIFO
queue, and when it reaches the head the rig spins up a container with the
ESP32-C6 attached and drops the agent into an SSH shell with a full ESP toolbox
(flash, serial, JTAG/GDB, BLE, WiFi provisioning). On release (or lease expiry)
the container is torn down and the next waiter is promoted.

## Components

| Component       | Where           | What                                                                                     |
| --------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `hitl-managerd` | Pi (systemd)    | Reservation queue + container lifecycle; JSON API over the tailnet. Go.                  |
| `hitl` CLI      | agent container | `reserve` / `status` / `release` / `ssh`. Go, distributed as a nix package.              |
| test container  | Pi (podman)     | `sshd` + ESP toolbox; the dev board (USBIP) + a BT controller inside. nix `dockerTools`. |
| Pi NixOS system | Pi              | sbc-deploy consumer: Tailscale, Podman, USBIP host, the daemon, the container image.     |

## Flow

```text
agent> hitl reserve
   └─POST /reserve {owner, ssh_pubkey}────────────► hitl-managerd
        (queued; agent polls /reservation/{id})       │  reconcile: head idle?
   ◄──────────────── active {ssh: host:port} ─────────┤  podman run test-image
        (agent heartbeats every 20s)                   │   +ESP32 (usbip) +authorized_keys
   └─ssh agent@rig -p PORT ─────────────────────────► container (flash / gdb / ble / …)
   … agent works …
   └─(session exits) POST /reservation/{id}/release ─► podman rm; promote next
```

Leases: an active reservation whose holder stops heartbeating past the lease
window is reaped (container torn down). The daemon `Cleanup`s stray containers on
startup (crash recovery).

## Multiple DUTs per rig (FUG-67)

A rig can host several DUTs, each its own container, published sshd port, and
device nodes, running concurrently. The daemon gets its DUT set one of three
ways, in precedence order:

- **explicit** — repeatable
  `--dut '{"name":…,"ssh_port":…,"devices":["host:container",…],"env":{…}}'` flags;
- **auto-discovery** (`--discover`, the deployed default) — enumerate the boards
  attached to the host by their stable `/dev/serial/by-id/*` symlinks and build
  one DUT per board: a **stable name derived from the board's USB serial**
  (`c6-071234`, a C6's serial is its MAC) so the DUT identity follows the physical
  board rather than a boot-order slot, tty pinned to `/dev/ttyACM0` in-container,
  and (for ESP32-C6 built-in USB-JTAG boards) `HITL_ADAPTER_SERIAL` lifted from
  the by-id name so JTAG selects the right adapter among identical boards. Only
  each board's primary `-if00` interface is taken. Discovery is **live**: the
  daemon polls (`--discover-interval`, default 3s) and syncs the DUT set, so a
  board hot-plugged after boot attaches, and an idle board unplugged for
  `--discover-retention` (default 30s) detaches — with no restart. Two things keep
  a flapping board (an ESP32-C6 re-enumerates its USB on every reset, so a
  resetting DUT blinks out of individual scans) from disrupting a session: the
  retention window means a board seen again within it is never dropped, and a DUT
  that is **currently held is never torn down by discovery** — it's retained until
  its holder releases and only then pruned if still gone (a genuinely dead lease
  is still reaped normally). Each DUT's sshd port is **sticky** (assigned once from
  `--ssh-port`, up to `--discover-max-duts`), so unplugging one board never
  renumbers another or disturbs its live session;
- **legacy fallback** (neither flag) — a single DUT synthesized from
  `--ssh-port`/`--device`, i.e. the original behavior.

The queue manager keeps one shared FIFO admission
queue and one active slot per DUT: `reconcile` brings a container up on every
free DUT, feeding it the earliest queued waiter that's compatible (unpinned, or
pinned to that DUT via `ReserveRequest.Device`). So a batch of reservations fills
all DUTs, and a busy DUT never blocks work another DUT could take.

**Client compatibility is preserved.** The client flow is already DUT-agnostic —
it reads `host:port` out of the reservation response and never assumes a port —
so distinct per-DUT ports need no client change. The new `device` fields and
`Status.Devices` are additive; the legacy `Status.Active`/`QueueLength` keep
their meaning by reporting the rig idle whenever _any_ DUT is free, so old clients
and the pool picker still work against a multi-DUT rig. Each DUT's serial tty is
remapped to `/dev/ttyACM0` inside its container, so the toolbox's
`--port /dev/ttyACM0` defaults hold on every DUT.

Per-DUT isolation: containers run **unprivileged** (`sbcDeploy`'s
`privilegedContainers = false`), so each is confined to its own DUT's tty
(mounted as `/dev/ttyACM0`) and can't see a neighbour's `/dev/ttyACM*` — a
privileged container would bind-mount the whole host `/dev` and leak every
board's serial into every container.

Raw-USB isolation (FUG-73): JTAG/flash go over libusb (`/dev/bus/usb`), not the
serial tty, so the tty pinning above isn't enough on its own. Each container gets
a **private `/dev/bus/usb` tree holding only its own board's node** instead of the
host-wide bus, so `ls /dev/bus/usb` shows just the reserved board and — the point
of the ticket — `hitl jtag`/`gdb`/`flash` in one reservation **cannot open, reset,
or flash a neighbour's DUT**: every libusb access ends at `open("/dev/bus/usb/
<bus>/<dev>")`, and a neighbour's node simply isn't there (ENOENT). (A subtlety:
libusb-1.0 _enumerates_ from sysfs, and the kernel's `/sys/bus/usb` is one shared
view podman can't filter per-container, so `lsusb` may still _list_ a neighbour —
but listing is harmless; the node it would open doesn't exist. Fully hiding it
from enumeration too would need usbip-style per-container host controllers, which
a shared kernel can't give.)

The tricky part is that `/dev/bus/usb/<bus>/<devnum>` and the node's major:minor
move on **every** re-enumeration, and a C6 re-enumerates on every reset; a static
per-devnum mount goes stale instantly. So the runner keys on the board's **stable
physical USB port** (resolved from the tty's sysfs, e.g. `1-2`) and a per-DUT
refresher re-syncs the single node whenever the board resets — isolation survives
re-enumeration. The device-cgroup still allows the whole USB major (the minor also
moves on reset); that's safe because visibility is gated by which nodes exist in
the private tree (one), and the container is unprivileged with `CAP_MKNOD` dropped,
so it can't fabricate a node for a neighbour. When the port can't be resolved (no
board attached, or a non-USB tty) the runner falls back to the whole-bus mount so
non-hardware reservations still come up. See `internal/runner/usbport.go`.

Remaining hardware caveats (shared single resources, follow-ups): BLE shares the
one host Bluetooth radio, and the provisioning AP is still rig-level.

## Logic-analyzer rig (shared FX2 capture)

An optional, board-independent capability adds LED-wire correctness/latency
testing: deploy any board target (`//pi/hitl:hitl` = Pi 5, `:hitl_pi3` = Pi 3) with
`SBC_ANALYZER=1`, which wires an **FX2/fx2lafw "Saleae clone"** 24 MHz logic
analyzer tapping the DUT's WS2812 DIN. It closes the gap flagged in
`pi/led_driver/README.md`, `docs/decisions.md`,
and `docs/runbook.md`: real cadence/wire correctness "needs a logic analyzer on a
bench — cannot be done in CI."

The analyzer is a **rig-level SHARED instrument**, not a per-container device — so
one cheap FX2 (8 channels) taps a couple of channels on each of several DUTs
instead of one-analyzer-per-DUT:

- **The daemon owns the FX2** (`internal/analyzer`). It never enters a container.
  A `Broker` serializes captures on the single instrument (one `sync.Mutex`) and
  maps each DUT name → its channel subset + wire protocol (a `--analyzer-channel-map`
  JSON). So `internal/runner`'s per-DUT raw-USB isolation is **unchanged**.
- **Container agents request captures over the API.** `POST /capture {device}`
  runs a triggered `sigrok-cli` capture scoped to that DUT's channels, decodes it
  (`rgb_led_ws281x` for WS2812, `rgb_led_spi` stacked on `spi` for APA102/SK9822 —
  both mainline decoders in libsigrokdecode ≥0.5.3), and returns the pixels. The
  `hitl-capture` toolbox tool is a thin client to it (`$HITL_CAPTURE_SERVER` =
  `host.containers.internal:<apiPort>`, injected by the runner).
- **One flake, two boards.** sbc-deploy injects the board via `$SBC_BOARD` at eval,
  so `nix/hitl-app.nix` keys its sigrok closure + capture flags + FX2 udev rules on
  `$SBC_BOARD == "raspberry-pi-3"` (`lib.optionals isAnalyzerRig …`). The Pi 5 rig
  image stays lean (no sigrok); the same appModule yields the capture-enabled Pi 3.

Decode is verified with **no hardware**: `internal/analyzer` synthesizes a WS2812
`.sr` and runs the real `sigrok-cli` decode path over it in a Go test (skips if
`sigrok-cli` is absent). The drive/expected-pixel contract is a pure unit test
(`//pi/hitl/tests:hitl_test` `test_led_pattern.py`); the on-hardware
reserve→flash→drive→capture→assert loop is `//pi/hitl/harness:led_capture`
(`manual`+`hitl`). Wiring caveat: the FX2 clone's inputs aren't reliably 5 V
tolerant — tap the 3.3 V side of the DIN or level-shift, and share ground.

**Capability-based rig selection.** A rig with an analyzer advertises it in
`/status` (`Analyzer{present, driver, protocols, channels}`), so a test picks a
rig by CAPABILITY, not by name or tag (tags are too coarse). `hitl reserve/run
--require analyzer` filters pool selection to analyzer-capable rigs
(`pool.Require`), and `led_capture` sets `require="analyzer"` + asserts the chosen
rig's `/status` before driving — so an analyzer test can never silently land on an
ESP-toolbox rig and fail at capture.

Latency is scaffolded (`CaptureResult.TriggerSample`/`SampleRate`); a full E2E
number needs the stimulus and the capture co-timed in one clock (route the "show
pattern" command through the daemon) — a hardware-gated follow-up.

**Acquiring the DUT→channel map.** Which `c6-<serial>` is wired to which analyzer
channel isn't knowable from software — it's a fact about the bench wiring. Two
pieces close that gap:

- `firmware/dut_id` — a minimal ESP32-C6 image that breathes the board's ONBOARD
  WS2812 (GPIO8, via `//libs/pins`) so a _reserved_ DUT is physically identifiable,
  with a serial toggle (`'0'`/`'1'`/`'t'` over its USB-CDC) to stop the blink.
  `//pi/hitl/harness:dut_id` walks a rig's DUTs one at a time (blink → eyeball →
  stop → next).
- `//pi/hitl/harness:map_la` — drives that blink DUT-by-DUT and prompts "which
  analyzer channel is THIS board on?", then `POST /analyzer/channel-map`s the
  assembled map. The broker holds the map behind a `sync.RWMutex` (so a live
  capture can't block a status/map read), applies it live, and persists it to
  `<state-dir>/analyzer-channel-map.json`, which `New` reloads at boot **overlaid
  on** the deploy-provided `--analyzer-channel-map` default — so a mapping "sticks
  to the board" across reboots with no redeploy. `GET /analyzer/channel-map` reads
  it back. POST rejects any key that isn't a real DUT on the rig.

## BLE HCI capture (btmon, FUG-93)

An agent debugging BLE can capture an HCI trace of its DUT's session (`hitl btmon
start|stop|status|fetch|capture`), read back as a btsnoop file that opens in
`btmon -r` and Wireshark.

`btmon` needs an `AF_BLUETOOTH` HCI monitor socket (`HCI_CHANNEL_MONITOR`) plus
`CAP_NET_RAW`/`CAP_NET_ADMIN`, none of which the unprivileged reservation
container has (and which we don't want to grant — containers are handed to
agents). So capture runs **host-side**: the daemon (already root) runs
`btmon -w` per reservation into that reservation's state dir, and the runner
bind-mounts the capture dir **read-only** into the container at
`/run/hitl/capture`. The agent reads/pulls the file over its existing SSH path;
start/stop go through the daemon API (`POST /reservation/{id}/btmon/{start,stop}`,
`GET …/btmon`). No capability changes anywhere.

Lifecycle mirrors the rest of per-reservation state: off until `start`, bounded
by a **size cap and a max-duration auto-stop** (a watchdog stops btmon at either,
so it can never fill the rig disk), and **torn down on release / lease expiry**
(the btmon process is killed and the file removed with the state dir in
`runner.Stop`). Concurrent DUTs each get their own capture — the kernel HCI
monitor channel is a broadcast channel, so several `btmon` readers coexist.

**Shared adapter — annotated, not isolated.** Because all DUTs share the one host
controller (below), a capture contains every DUT's BLE traffic for its window.
This is documented plainly and the trace is **annotated** by the DUT's BLE MAC
(`hitl btmon fetch --mac …` prints the `bluetooth.addr == <mac>` filter), not
isolated to it. The real fix is the per-DUT BLE radio open item.

## Packaging

- **Go** → `nix/packages.nix` (`buildGoModule`, `vendorHash = null` since
  stdlib-only) → `bin/hitl-managerd` + `bin/hitl`. Verified building via nix.
- **Container** → `nix/container.nix` (`dockerTools.buildLayeredImage`), loaded
  into Podman at boot.
- **Pi system** → `flake.nix` = `sbc-deploy.lib.mkSbcProject { appModules =
[ ./nix/hitl-app.nix ]; … }`; Bazel `sbc_application` gives the
  image/deploy/ssh targets. The `hitl` CLI is `packages.<system>.hitl` for
  agents to `nix run`/install.

## Observability (FUG-117)

`hitl-managerd` serves Prometheus metrics at `GET /metrics` (same port as the
API): reservation-queue depth, per-DUT occupancy, reservation-lifecycle
counters, and host CPU/memory/temperature. Because the rigs are tailnet-only
(no inbound), a **Grafana Alloy** agent runs on each Pi and `remote_write`s the
metrics _out_ to Grafana Cloud (free tier), where dashboards — kept as code in
the repo and CI-synced — plot the fleet. CI job pass/fail is reported alongside
(Grafana Cloud GitHub integration and/or an optional Loki push). Full design,
metric catalog, and setup: [`observability/README.md`](./observability/README.md).

## USBIP (dev board → container)

The ESP32-C6's USB is exported by `usbipd` on the Pi (`usbip-host`) and attached
inside the container's netns (`vhci-hcd`), giving it full USB (serial + JTAG),
not just `/dev/ttyACM0` — needed for flashing resets and OpenOCD. The specific
bus id / udev rule is hardware-dependent (see "Open items"). MVP falls back to
`--device` passthrough of the tty until USBIP is wired.

## Security / trust

The tailnet is the outer trust boundary (only tailnet peers reach the daemon).
Each reservation authorizes only the holder's SSH key inside its container; the
container is destroyed on release, so state never leaks between holders.

## Phasing

1. **MVP (this pass):** daemon + CLI + queue/lease + Podman runner (compiled &
   nix-packaged); container skeleton (sshd + esptool + serial); Pi module
   (Tailscale + Podman + the daemon). `--device` tty passthrough.
2. USBIP proper; OpenOCD + GDB for the JTAG debug port.
3. BLE (BlueZ/bleak) scan/connect/command; WiFi provisioning helpers.
4. Robustness: reservation persistence across daemon restarts, metrics, richer
   status, multi-rig.
5. Multiple DUTs per rig — done (FUG-67): concurrent per-DUT containers/ports,
   shared FIFO with per-DUT slots, backward-compatible API. Raw-USB (JTAG/flash)
   isolation between concurrent containers — done (FUG-73): per-DUT private
   `/dev/bus/usb`, keyed on the stable physical port, refreshed across
   re-enumeration. Host-side BLE HCI (btmon) capture per reservation — done
   (FUG-93): bounded, torn down on release, read back as btsnoop, annotated by
   the DUT BLE MAC (the adapter is still shared — see the caveat above).
   Remaining: per-DUT BLE radio; per-DUT AP.

## Open items (need the hardware / decisions)

- ESP32-C6 USB bus id + udev rules (for USBIP bind and stable device names).
- BT controller: Pi built-in vs USB dongle — RESOLVED. The Pi 5 onboard Cypress
  BCM4345/6 marginally fails LE connection establishment (0x3E storm, 0 GATT;
  measured 0/20 vs a USB dongle's 20/20 on the same DUT). `SBC_BT_DONGLE=1` routes
  BLE central onto an RTL8851BU USB dongle's BT half: ships its firmware, flips it
  out of CD-ROM mode, and points btmon (`-i`) + the container's bleak
  (`$HITL_BLE_ADAPTER`, resolved by USB bus so it's index-order-robust) at it.
- Tailscale auth-key provisioning (secret): baked, `environmentFile`, or
  `tailscale up` once by hand. MVP: an `environmentFile` the daemon/tailscale
  reads (kept out of the image).
- Rootless vs rootful Podman (device access + USBIP likely want rootful for MVP).
