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

One ESP32 == one active reservation. Leases: an active reservation whose holder
stops heartbeating past the lease window is reaped (container torn down). The
daemon `Cleanup`s stray containers on startup (crash recovery).

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

## Open items (need the hardware / decisions)

- ESP32-C6 USB bus id + udev rules (for USBIP bind and stable device names).
- BT controller: Pi built-in vs USB dongle; how it's exposed into the container.
- Tailscale auth-key provisioning (secret): baked, `environmentFile`, or
  `tailscale up` once by hand. MVP: an `environmentFile` the daemon/tailscale
  reads (kept out of the image).
- Rootless vs rootful Podman (device access + USBIP likely want rootful for MVP).
