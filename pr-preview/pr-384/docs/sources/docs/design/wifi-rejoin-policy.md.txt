# Wi-Fi rejoin policy and render isolation (netstack C6)

Status: implemented (netstack build). Follows #363, which removed the reboot-to-rescan:
the board now finds a missing network with an in-place background sweep while the effect
keeps playing.

Two questions drove this:

1. Do scanning, joining or failing to join disturb the LED output on the single-core C6?
2. How should the board (re)join when it isn't on its network, including a unit that is
   set up on an AP once and then deployed somewhere it will never see that AP again?

## 1. Render isolation

### What shares the core

| Task / context | Priority | Wi-Fi work |
|---|---|---|
| xmit (WS2812 transmit kick) | 11 | none; the frame goes out by PARLIO + GDMA from SRAM |
| render | 10 | none |
| loopTask (netstack) | 9, or 10 while a wss session streams | RX drain, join, PBKDF2 (at 8), DHCP, TLS, background sweep hops |
| vendor WiFi task | 23 | `esp_wifi_set_channel` (one per sweep hop) |
| esp_timer task | 22 | the 4 ms coex tick (BLE slices) |

### Loop priority

The netstack loop runs one priority below render whenever the link is joining,
scanning, leasing, deriving a PMK, or idle, so none of that work can delay a frame. It
moves up to render's priority only while a wss session is open on a leased link with no
sweep or PMK derivation running (`netstack_data_plane_active`, re-checked every loop).
Equal priorities are time-sliced per 1 ms tick whenever both are runnable, so a
streaming session gets about half of a busy CPU. A rejoin always tears the session down
first, so the rejoin path never runs at render's priority.

Keeping the loop below render all the time starved streaming. It then ran only in
render's sleeps: about 3-4 ms of each 12 ms frame under a light 80 fps effect. A
30 fps texture stream outran it. `video_latency_netstack` (hitl-rig-2, c6-fa0324,
24x24 RGB565 at 30 fps for 120 s, one reservation, same DUT):

| loop priority | verdict | latency p50 / p95 / p99 ms | loop gap (5 s max), p50 | zero windows | end |
|---|---|---|---|---|---|
| always below render | FAIL | 523 / 1003 / 1160 | 134 ms | 230 | device closed the session at 104 s |
| always at render (before) | PASS | 20.6 / 27.4 / 34.7 | 30 ms | 0 | done |
| follows the data plane | PASS | 20.7 / 29.1 / 39.2 | 31 ms | 0 | done |

While a session streams, a light effect renders at ~55-60 fps instead of 80 (the
autoscaler sees the shared CPU), as before #371.

### Measurement

`//pi/hitl/harness:wifi_cadence` drives every recovery path on the wired console while an
effect plays and times the LED output across it from both sides: the rig's logic analyzer
on the WS2812 line (frame start intervals, damaged frames), and the firmware's 1 Hz
`[ft]` line (printed outside the timed frame span, so fx_bench is unaffected) (render-start and wire-out-start interval min/mean/max, the largest
effect time step). Phases: `steady` (baseline), `scan` (one 13-channel sweep), `dhcp`
(lease dropped, re-DISCOVER), `wrongpsk` (the rig AP with a wrong passphrase), `missing`
(an SSID that doesn't exist), `rejoin` (the right credentials again), `giveup` (the
random-MAC stable-address fallback). Effects: a light one at the wire ceiling
(plasmaHueFixed, 250 LEDs, ~77 fps) and a heavy one (slowLag, ~5.4 fps, lagging).

Results (hitl-rig-2, c6-003f08, analyzer on the strip; wire frame-interval deviation from
the steady median, ms; "after" is the final gate run):

| Effect / phase | before: max | before: p99.9 | after: max | after: p99.9 |
|---|---|---|---|---|
| light steady (13.0 / 12.0 ms) | 6.14\* | 6.14\* | 0.41 | 0.39 |
| light scan | 1.44 | 1.44 | 0.50 | 0.50 |
| light dhcp | 1.53 | 1.53 | 0.49 | 0.49 |
| light wrongpsk | 5.12 | 4.62 | 0.48 | 0.46 |
| light missing | 4.42 | 4.39 | 0.52 | 0.48 |
| light rejoin | 4.50 | 4.49 | 0.53 | 0.49 |
| light giveup | 1.80 | 1.61 | 0.58 | 0.46 |
| heavy steady (183.6 / 183.3 ms) | 1.43 | 1.43 | 1.69 | 1.69 |
| heavy scan | 1.40 | 1.40 | 1.39 | 1.39 |
| heavy dhcp | 1.69 | 1.69 | 1.09 | 1.09 |
| heavy wrongpsk | 12.75 | 12.75 | 2.44 | 2.44 |
| heavy missing | 13.8 | 13.8 | 2.07 | 2.07 |
| heavy rejoin | 13.09 | 13.09 | 2.72 | 2.72 |
| heavy giveup | 1.67 | 1.67 | 1.67 | 1.67 |

\* the console attach (below), not Wi-Fi. After the fixes no phase had a wire excursion,
a damaged frame, a stalled transmit, or an effect time step larger than its frame
interval. A heavy frame's residual (≤ 2.7 ms, 1.5 % of its 183 ms) is its own cost
varying, as in steady.

Two artifacts of the measurement itself, not of the DUT: attaching a reader to the C6's
USB console makes it flush its buffered log, and for ~0.5 s frames ran 2-3 ms late (the
before "steady" row); and the analyzer intermittently decodes ~16-40 glitch bits after
every frame for up to ~1.7 s from the START of a capture — in every phase including
steady, never later in a capture. The harness arms the analyzer after the console
attach, grades nothing in the first 2 s of a capture, and issues each phase's command
2.5 s in. A field unit has no console host attached.

The gate (`wifi_cadence`, `--gate`) fails on any wire frame interval in a scan / join
phase that deviates from the steady median by more than max(3 ms, 2 % of the period,
1.5 × the steady phase's p99.9 deviation), on a damaged frame, or (without an analyzer) on a render /
wire-out interval beyond the steady maximum by 4 ms. Infra problems are SKIP.

## 2. Rejoin policy

Persisted in NVS (`wifi_pol`), applied without a reboot, and settable from the app's
device settings, the agent (`set_wifi_policy` / `get_wifi_policy`), the BLE player
transport (the same protocol arms), and the wired console:

```
WIFI MODE <auto|fixed|manual|offline> [cap=S] [every=S] [decay=H] [sparse=S] [force]
WIFI REJOIN        WIFI STATUS
WIFI SCAN | DHCP | GIVEUP   (link diagnostics)
```

| Mode | Behaviour when the network is missing |
|---|---|
| `auto` (default) | Background sweeps 5 s, 10, 20, 40 … up to `scan_cap_s` (default 60). After `decay_after_h` hours (default 24; 0 = never) without ever seeing the network, at most one sweep per `sparse_interval_s` (default 900). |
| `fixed` | One sweep every `interval_s` (default 300). |
| `manual` | Never scans or joins on its own. A rejoin command or a new provision opens a 2 min join window (the auto backoff inside it). A dropped link stays down until told. |
| `offline` | The radio is off: never started at boot, no scans, no RF. Switching to offline at runtime goes silent at once (goodbye to the AP, no TX, MAC released to sleep); the radio is fully off from the next boot. The show plays; BLE and the console stay up. Credentials are kept. |

### Decay default

The decay is on by default (24 h → 15 min). A unit whose AP is gone for good stops
sweeping every minute (each sweep is ~1.6 s of channel hopping), yet a unit whose AP was
only down for a weekend still rejoins on its own within 15 min of it coming back. Decaying
to `offline` instead would strand such units, so offline is only ever an explicit choice.
The unseen time is persisted hourly (`wifi_unseen`), so a nightly power cycle doesn't
reset the clock.

### Forward-deployed units

The intended flow: set the unit up on an AP (map, effects, settings, maybe an OTA
update), confirm any update, then switch it to `offline` from the app, the agent or the
console while it is still connected. Credentials stay stored, so `auto` later rejoins
without re-entering them. In the field it is reconfigurable over BLE (the player
transport, or Improv) and the wired console. A new provision while offline switches the
mode back to `auto` and brings the radio up in place.

There is no SoftAP and no physical button on the netstack build. BLE and the console are
the escape hatches.

### OTA interaction

A freshly installed update boots pending verification and must prove itself before a
deadline, or it rolls back to the loader. The rules:

- **Going offline / manual while an update is unconfirmed is refused** (`refused:
  "ota_pending"`) unless forced. The app warns and asks twice before forcing; the agent
  never forces unless explicitly asked.
- **The health check requires a lease only when one is expected:** the policy lets the
  board join on its own (not offline, not manual outside a window) **and** the network
  was seen this boot. An AP that is simply absent (a unit moved to the field right after
  an update) is no evidence against the image, so it is confirmed on rendering alone and
  never rolls back merely because the AP is gone. An AP that is present but can't be
  joined still rolls a broken image back.
- In offline mode the TLS-ready requirement is waived too (there is no TLS server).
- The OTA loader (recovery) ignores the policy and always tries to get online.

### Status

`get_wifi_policy` reports the mode and fields, the link state (offline / unprovisioned /
idle / searching / joining / joined), seconds to the next sweep, sweeps run, the SSID,
how long the network has been unseen, whether the decay is in force, `ota_pending`, and
`radio_on`. The app's device sheet shows it as one line ("Wi-Fi: offline mode",
"Wi-Fi: rejoining, next scan in 40 s", …).

### Scope notes

- `fixed` has no time-of-day schedule windows (the board has no reliable wall clock).
- The vendor-WiFi (lwIP) build advertises the feature through the shared player core but
  does not act on it. That build is deprecated.
