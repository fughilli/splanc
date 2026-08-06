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

## Packaging

- **Go** → `nix/packages.nix` (`buildGoModule`, `vendorHash = null` since
  stdlib-only) → `bin/hitl-managerd` + `bin/hitl`. Verified building via nix.
- **Container** → `nix/container.nix` (`dockerTools.buildLayeredImage`), loaded
  into Podman at boot.
- **Pi system** → `flake.nix` = `sbc-deploy.lib.mkSbcProject { appModules =
[ ./nix/hitl-app.nix ]; … }`; Bazel `sbc_application` gives the
  image/deploy/ssh targets. The `hitl` CLI is `packages.<system>.hitl` for
  agents to `nix run`/install.

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
   re-enumeration. Remaining: per-DUT BLE radio; per-DUT AP.

## Open items (need the hardware / decisions)

- ESP32-C6 USB bus id + udev rules (for USBIP bind and stable device names).
- BT controller: Pi built-in vs USB dongle; how it's exposed into the container.
- Tailscale auth-key provisioning (secret): baked, `environmentFile`, or
  `tailscale up` once by hand. MVP: an `environmentFile` the daemon/tailscale
  reads (kept out of the image).
- Rootless vs rootful Podman (device access + USBIP likely want rootful for MVP).
