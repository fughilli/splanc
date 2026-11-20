# Opt-in device metrics: "Send feedback to Fug Studio"

Status: built in this PR (issue #574). The relay endpoints and the Grafana
dashboard ship with it. They collect nothing until the owner deploys the relay
(see [Deploy](#deploy-owner)) and a user switches the setting on.

## Why

Players have no way to tell us how they do in the field: frame rates, memory
headroom, crashes, Wi-Fi and Bluetooth drops, and mesh delivery. The first
consumer is mesh field monitoring for the adaptive flood/tree threshold (#573).
That issue needs the chosen mode, delivery, airtime, relay load and switch
events from real deployments.

## Rules

- **Opt-in only.** The setting is off by default, and nothing is collected,
  counted or sent while it is off. The app's collector starts no timer and makes
  no player request. The device keeps only a few counters it would keep anyway.
- **Granular.** The user picks each category: performance, reliability, mesh,
  usage. The app reads only the chosen categories from each player. The relay
  drops any field outside a chosen category, and any field that isn't on the
  list.
- **Transparent.** "See exactly what's sent" shows the literal JSON of the next
  upload and of the last one, and what each field means.
- **No personal data.** Values are numbers, booleans, versions and closed
  vocabularies only. Never sent:
  - device names, SSIDs, IPs, MAC addresses or locations;
  - maps, effects, or anything the user typed;
  - credits account ids.
- **Pseudonymous, rotating.** Uploads carry an install pseudonym and per-player
  pseudonyms:
  - both are random codes derived from a secret only the app holds;
  - they rotate every 30 days;
  - they are never linked to a Splanc AI account, a bridge or an IP.
- **Bounded.** The data is kept 90 days at most, and the user can delete it on
  request.

## The metrics (schema v1)

The single source is `web/src/metrics/metricsSchema.ts`. The app, the relay
validator, the Grafana allowlist (`ops.ts`) and the "what's sent" view all read
it. The player's reply is `DeviceMetrics` in `ledmapper.proto`
(`get_device_metrics` = 120, `device_metrics` = 64).

| Category | Field | Kind | Source on the C6 |
| --- | --- | --- | --- |
| performance | `fps_target`, `fps_current`, `fps_achieved`, `fps_min`, `fps_max` | gauge (fps) | frame-rate autoscaler (`FpsController`) |
| performance | `fps_lagging` | bool | autoscaler |
| performance | `lag_events` | count | lag-start transitions (`lm_fps_take_lag_notify`) |
| performance | `heap_free`, `heap_min_free`, `heap_largest_free` | gauge (bytes) | `esp_get_*_heap_size`, `heap_caps_get_largest_free_block` |
| performance | `led_count` | gauge | `lm_led_count` (both channels) |
| reliability | `uptime_s` | gauge (s) | `esp_timer_get_time` |
| reliability | `reset_reason` | enum | `esp_reset_reason()` of this boot |
| reliability | `boot_count`, `wdt_resets`, `panic_resets`, `brownout_resets` | count since power-on | RTC no-init record (20 B of LP RAM) |
| reliability | `wifi_joins`, `wifi_link_losses` | count since boot | netstack DHCP lease gained / lost (deauth, disassoc, expiry) |
| reliability | `wifi_rssi_dbm` | gauge (dBm) | EWMA (1/8) of the RX-vector RSSI of frames sent by our AP |
| reliability | `ble_drops` | count since boot | BLE link left "connected" with a reason other than a clean close (0x13/0x16) |
| mesh | `mesh_mode` (0 none, 1 flood, 2 tree), `mesh_members`, `mesh_delivery_permille`, `mesh_airtime_permille`, `mesh_relay_load_permille`, `mesh_mode_switches` | enum / gauge / count | **stubbed**: 0 until the mesh stack is in the player; `LmSysMetrics.mesh_*` is the seam |
| usage (app) | `players`, `sessions`, `effects_deployed`, `screen_{play,editor,mapping,maps,settings}` | gauge / count since the last upload | the app |

Every player sample also carries:

- `dev`, the player pseudonym;
- `fw`, the firmware version from `welcome`;
- `board` (`esp32c6`, `esp32p4`, `host`);
- `transport` (`wss`, `ble`, `lan`);
- `age_s`, the seconds between the sample and the upload.

A player with `mesh_mode` 0 sends no mesh fields at all.

### Upload payload (`POST /metrics`)

```json
{
  "schema": 1,
  "install": "Q2xhdWRlIHdhcyBoZXJl",
  "app": "1.20.0",
  "platform": "web",
  "categories": ["performance", "reliability", "usage"],
  "devices": [
    {
      "dev": "k3J9xQ0aZ7mN2pLw", "fw": "1.9.0", "board": "esp32c6", "transport": "wss", "age_s": 420,
      "fps_current": 60, "fps_achieved": 58, "fps_min": 25, "fps_max": 80, "fps_lagging": false,
      "heap_free": 81234, "heap_min_free": 54012, "heap_largest_free": 30720, "led_count": 512,
      "uptime_s": 86400, "reset_reason": 3, "boot_count": 2, "wifi_joins": 1, "wifi_rssi_dbm": -61, "ble_drops": 0
    }
  ],
  "usage": { "players": 2, "sessions": 3, "effects_deployed": 5, "screen_play": 4, "screen_editor": 1 }
}
```

Limits:

- the body is at most 24 KiB and holds at most 32 players;
- pseudonyms match `^[A-Za-z0-9_-]{12,24}$`;
- each numeric field has its own upper bound;
- `wifi_rssi_dbm` must be in [-127, 0].

## Firmware (C6 player)

- **`firmware/player_app/metrics_ffi.rs`.**
  - It answers `get_device_metrics`, zero-copy into the reply buffer: there is
    no by-value `ServerMessage`, and the firmware profile skips
    `DeviceMetrics.board`.
  - The reply is built **on request**, from the autoscaler plus an
    `LmSysMetrics` snapshot that main.cpp fills through a callback it registers
    at boot (`lm_metrics_set_source`).
  - Host builds register no callback, so no link stubs are needed.
- **Added state.**
  - The callback pointer and `LAG_EVENTS` (8 B of .bss);
  - the boot record (20 B in RTC no-init memory, not the heap);
  - 4 netstack counters (16 B);
  - `LAST_RSSI` (1 B).
  - Nothing is allocated.
  - Render paths are untouched: the lag counter sits on the lag-change
    notification, not on the frame.
- **Cost on the hot path.** The RX drain does one byte load per frame
  (`LAST_RSSI`), plus one EWMA update for frames sent by our AP.
- **Kiosk.** A locked kiosk refuses `get_device_metrics`, like every arm it
  doesn't list, so a visitor's app can't report an owner's device.
- **RSSI.** The RX vector's first byte is the frame's RSSI on the C6. Readings
  outside [-110, 0) dBm are ignored, and the value is confirmed on the HITL
  rigs.

## App

- **Settings ▸ Privacy** (`#/settings/privacy`, `web/src/ui/screens/privacySettings.ts`)
  - the "Send feedback" switch;
  - one switch per category;
  - the status of the last upload;
  - "See exactly what's sent" (a sheet);
  - "Your data", with the retention text, the privacy notice and **Delete my
    data**. That button opens a confirmation, then shows the result.
- **Collector** (`web/src/metrics/collector.ts`; `appMetrics.ts` wires it to the
  live connections).
  - It reads each connected player that lists the `device_metrics` feature
    every 15 min, and keeps the latest sample per player.
  - It uploads every 6 h, and retries with exponential backoff (1 h up to 24 h,
    or the relay's `retry-after`). A 503 waits a day.
  - It sends `credentials: "omit"`.
  - A 410 means the pseudonym was deleted: the app starts a new one.
  - The secret rotates every 30 days. The app keeps the last four (under
    120 days), so a deletion covers every pseudonym the relay could still hold.
- **Usage counts** come from the hash route (screen opens), boot (sessions), and
  the effect editor, Play and Show deploys. Each is a no-op unless Usage is on.

## Backend

- **Relay endpoints** (`agent/relay/src/deviceMetrics.ts`):
  - `POST /metrics`;
  - `POST /metrics/delete` `{secret}`;
  - the owner's `GET`/`POST /metrics/deletions` (FEEDBACK_ADMIN_TOKEN).
  - The Pages worker forwards `/metrics` and `/metrics/delete`.
- **Validation.** `validateMetricsUpload` checks the structure, drops fields
  that aren't allowed, and counts them in `dropped`.
- **Rate limits** (Directory DO):
  - per install: 12 a day;
  - per IP: 60 an hour (the IP is only the bucket key and lives for the hour);
  - global: 50,000 a day;
  - deletion requests: 10 an hour per IP.
- **Store.** Lines go to Grafana Cloud Logs through `ops.ts` (component
  `device-metrics`), the same allowlist path as the business events
  ([ops-grafana.md](ops-grafana.md)):
  - `dm_upload`, one per upload;
  - `dm_device`, one per player sample;
  - `dm_usage`;
  - `dm_rejected`, `dm_rate_limited` and `dm_delete_requested`.
  - The `install` and `dev` pseudonyms are fields in the JSON line, not labels.
- **Dashboard.** **Splanc — Device health** (`/d/splanc-biz-device-health`) is
  in the private folder `splanc-business` and is generated by
  `ops/grafana/business/gen_dashboards.py`. Its rows:
  - coverage;
  - performance;
  - reliability;
  - mesh (#573);
  - usage.
- **Retention.** 90 days at most. The Grafana stack's log retention is the hard
  bound (the owner sets it: see Decisions). Tombstones and queued deletions
  expire after 90 days.
- **Deletion.**
  - With `GRAFANA_LOKI_DELETE_TOKEN` (`logs:delete`), the relay files a Loki
    delete request for `{component="device-metrics"} |= "\"install\":\"<id>\""`
    over the retention window. Grafana carries it out within days.
  - Without the token, the request is queued, and the owner lists and clears it
    with the admin token.
  - Either way, a tombstone answers 410 to later uploads from that pseudonym.
  - The secret never reaches Grafana.
- **Kill switch.** `DEVICE_METRICS=off` (a var) makes every endpoint answer 503.
  Without the Grafana push settings, they answer 503 as well.

## Deploy (owner)

These steps need approval and aren't done by this PR.

1. **Relay.** Deploy `agent/relay` (`agent/relay/deploy.sh`) and the Pages site
   (`/metrics` forwarding in `web/_worker.js`). The `GRAFANA_LOKI_*` secrets
   already exist, so ingest starts once both are deployed.
2. **Optional: immediate deletion.**
   - Create a Grafana Cloud access-policy token with `logs:delete` on the
     splanc stack.
   - Store it as `/workspace/credentials/grafana_loki_relay_delete.token`.
   - Set it on the relay:
     `pnpm dlx wrangler@4 secret put GRAFANA_LOKI_DELETE_TOKEN --config agent/relay/wrangler.toml < /workspace/credentials/grafana_loki_relay_delete.token`
3. **Dashboard.** Run
   `GRAFANA_TOKEN_FILE=/workspace/credentials/grafana_local.token python3 ops/grafana/business/sync.py`.
   It adds the Device health board, and touches nothing outside the private
   folder.
4. **Retention.** Confirm the stack's log retention is 90 days or less
   (Grafana Cloud ▸ Logs ▸ retention).
5. **Firmware.** Release a firmware version with `device_metrics`. Older
   firmware is skipped silently.
6. **Stores.** Update the App Store privacy answers and the Play data-safety
   form from [store-privacy-labels.md](../store-privacy-labels.md), and publish
   the privacy notice ([privacy.md](../privacy.md)) where the app links it.
