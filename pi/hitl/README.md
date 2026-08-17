# HITL rig

Hardware-in-the-loop test bench: a Raspberry Pi with an ESP32-C6 over USB,
exposed to agents (via issuefleet) as a reservable, containerized environment
over Tailscale. See [`DESIGN.md`](./DESIGN.md) for the architecture.

## For an agent

```sh
nix run 'path:pi/hitl#hitl' -- reserve       # queue, then drop into an SSH shell on the rig
#   … flash / serial / gdb / ble … then exit the shell to auto-release
nix run 'path:pi/hitl#hitl' -- status
```

The CLI finds rigs on the tailnet by their `tag:splanc-hitl` ACL tag and reserves
the shortest-queue one — no server to set. Pin one with `--server`/`$HITL_SERVER`,
or give an explicit `$HITL_SERVERS` list to override discovery (see the CLI usage
and `internal/tailnet`).

`hitl reserve` waits in a FIFO queue; at the head it gets a container with the
ESP32 attached and your key authorized, SSHes you in, heartbeats to hold the
lease, and releases on exit (`--keep` to hold it).

## Deploying the rig

```sh
bazel run //pi/hitl:hitl.keys        -- init
bazel run //pi/hitl:hitl.image_sd    -- --device /dev/diskN   # flash a card
bazel run //pi/hitl:hitl.deploy_live -- hitl-rig-1           # or push to a running rig
```

(On macOS, start the builder first: `bazel run @sbc_deploy//:linux_builder`.)

### Rig naming (canonical)

Every box has **one** name, `hitl-rig-<n>`, with a **mandatory** numeric suffix
`<n>` unique to the box (`hitl-rig-1`, `hitl-rig-2`, … — never a bare `hitl-rig`).
Capability (e.g. a logic analyzer) is discovered from `/status`, not encoded in
the name. The name is set at deploy with the `--hostname` flag and used verbatim
in all three places below, so a box is addressed identically everywhere — no
`hitl-rig`/`hitl-rig-2` ambiguity, and `hitl reserve` (including
`--require analyzer`) finds it with no `--server`.

| what               | value          | example      |
| ------------------ | -------------- | ------------ |
| System hostname    | `hitl-rig-<n>` | `hitl-rig-3` |
| Tailscale hostname | `hitl-rig-<n>` | `hitl-rig-3` |
| AP SSID            | `hitl-rig-<n>` | `hitl-rig-3` |

Set it with `--hostname` (a plain Pi 3 rig `hitl-rig-3`):

```sh
bazel run //pi/hitl:hitl_pi3.deploy_live -- --hostname hitl-rig-3 <host-or-ip>
```

### Board + capabilities (mix and match)

The board is a **bazel target** (`:hitl` = Pi 5, `:hitl_pi3` = Pi 3B/3B+); the two
optional capabilities are **env flags** at deploy, independent of the board:

| flag              | effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `SBC_ANALYZER=1`  | wire the shared FX2/fx2lafw logic analyzer (sigrok `/capture`) |
| `SBC_AP_DONGLE=1` | host the AP on a dedicated RTL8851BU USB radio (`ap0`) instead |
|                   | of onboard `wlan0` — for a board that can't AP                 |

So any combination works, e.g. an **analyzer on a Pi 5** (onboard-wlan0 AP) —
capabilities are env flags, the name is `--hostname`:

```sh
SBC_ANALYZER=1 bazel run //pi/hitl:hitl.deploy_live -- --hostname hitl-rig-2 <host-or-ip>
```

### Logic analyzer (shared FX2)

With `SBC_ANALYZER=1` the rig hosts an FX2/fx2lafw logic analyzer tapping the DUT's
WS2812 DIN, for LED-driver correctness / latency tests.

The FX2 is a **shared, daemon-owned instrument** (its channels tap a couple per
DUT), so inside a reservation you capture + decode the wire with:

```sh
hitl-capture               # decode this DUT's LED line -> "idx: #rrggbb"
hitl-capture --json --sr /tmp/cap.sr   # raw pixels + a .sr for PulseView
```

Wiring: share ground, and tap the **3.3 V** side of the DIN (or level-shift) — the
FX2 clone's inputs aren't reliably 5 V tolerant. See DESIGN.md "Logic-analyzer
rig". The correctness suite is `//pi/hitl/harness:led_capture` (manual+hitl); the
pattern/pixel + WS2812 decode contracts are unit-tested off hardware.

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
bazel test //pi/hitl/tests:hitl_test           # pure-logic units (codec/sync)
bazel run  //pi/hitl/harness:e2e -- \
    --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar
    # reserve → flash → improv → ws; no --wifi-* needed (see below)
```

The e2e driver doesn't reimplement the checkout mechanism: it shells out to the
`hitl` CLI (bundled in its runfiles) for rig selection, reserving, flashing,
file copy, and the ws ssh-tunnel — so there's one implementation to keep correct.
Rig selection is the CLI's (tag discovery, or `$HITL_SERVERS`).

**No external WiFi.** The rig hosts its own provisioning AP (`hitl-<hostname>`) on
its onboard radio, concurrently with its STA uplink — a NetworkManager AP profile
the daemon brings up per-reservation (`ipv4.method=shared` → DHCP + NAT). The DUT
is ImprovBLE-provisioned onto _that_, and the harness fetches the SSID/PSK from the
daemon (`hitl wifi`), so a run needs no nearby network or creds. `--wifi-ssid`
still overrides it. The AP is off at boot (`autoconnect=false`), so it can never
strand the rig — worst case it spoils one reservation.

Because it's one radio, the AP is co-channel with the STA uplink, so the uplink is
pinned to **2.4 GHz** (`sbcDeploy.wifi.band = "bg"`): the ESP32-C6 is 2.4 GHz-only,
so the AP — and therefore the uplink — must be 2.4 GHz. The rig's STA SSID must
have a 2.4 GHz BSS. (For a 5 GHz uplink you'd need a second radio for the AP — a
USB dongle or Ethernet uplink.)

The pure-logic units (`//pi/hitl/tests:hitl_test`) run in the normal
`bazel test //...` lane so the Improv/sync/pool codecs can't drift. The
**on-hardware** tests are `py_test`s tagged `["manual", "hitl"]` — `manual` keeps
them out of `bazel test //...`, and `hitl` puts them in their own lane
(`.github/workflows/hitl.yaml`), which joins the tailnet with a `TS_AUTHKEY`
secret and runs the whole set one at a time against a free rig from the pool
(each reserves via the `hitl` CLI, so it never queues behind a busy one).

The lane is **not a maintained list** — it collects every `hitl`-tagged target by
query, so a new test joins just by carrying the tag:

```sh
bazel test $(bazel query 'attr(tags, "\bhitl\b", tests(//...))') --test_output=streamed
```

See AGENTS.md "Adding an on-hardware test" for the `py_test` pattern (reserve →
flash → provision → tunnel → drive the player socket).

## Layout

```text
pi/hitl/
  cmd/hitl-managerd/   # Pi-side reservation daemon (Go)
  cmd/hitl/            # agent CLI (Go)
  internal/{api,queue,runner,pool,tailnet}/
  internal/analyzer/   # shared logic-analyzer broker (sigrok capture + decode)
  harness/             # Python e2e driver + thin hitl-CLI client (FUG-33)
    led_pattern.py     # known-pattern + expected-pixel helpers (pure)
    hitl_led_capture.py# on-hardware LED correctness test (manual+hitl)
  tests/               # pure-logic unit tests (codec/sync/led-pattern)
  nix/
    packages.nix       # buildGoModule -> bin/hitl{,-managerd}
    container.nix      # dockerTools test container (sshd + ESP toolbox + hitl-capture)
    hitl-app.nix       # NixOS: podman, tailscale, usbip, the daemon, (Pi3) sigrok
    sigrok.nix         # host sigrok-cli + fx2lafw firmware (logic-analyzer rig)
  flake.nix            # mkSbcProject + packages.<system>.hitl
  BUILD.bazel          # sbc_application "hitl" (Pi 5) + "hitl_pi3" (Pi 3); caps via env
```
