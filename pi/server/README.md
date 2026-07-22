# M2 — `pi/server` (web server + WebSocket control plane)

The long-lived FastAPI/uvicorn process on the Pi (design doc §3, §6 M2). It
serves the web app, runs the §7 WebSocket protocol, manages **one** capture
session at a time, persists detection records to a session log on disk, triggers
reconstruction (M3) when a capture ends, and serves the resulting maps.

## Run it

```sh
# Bazel-built CLI (brings its own deps):
bazelisk run //pi/server:serve -- \
    --host 0.0.0.0 --port 8080 \
    --session-dir /tmp/ledmapper/sessions --maps-dir /tmp/ledmapper/maps

# On the Pi it runs as led-server.service binding :80, serving --web-root.
```

| Flag                | Default                       | Meaning                                                                   |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `--host` / `--port` | `0.0.0.0` / `80`              | bind address                                                              |
| `--web-root`        | _none_                        | built web app (M5–M8) to serve at `/`; falls back to a Phase-0 hello page |
| `--session-dir`     | `/var/lib/ledmapper/sessions` | where capture logs are written                                            |
| `--maps-dir`        | `/var/lib/ledmapper/maps`     | where reconstructed maps are stored                                       |
| `--led-count`       | `1024`                        | default code-book size used in `welcome` before `start_mapping`           |
| `--bit-period-ms`   | `100`                         | Gray-code bit hold time (design doc §12)                                  |

## HTTP + WebSocket surface

- `GET /healthz` → `{"status":"ok"}`
- `WS /ws` → the entire §7 control + data plane
- `GET /maps/{id}` → reconstructed `OutputMap` JSON (§7.5)
- `GET /maps/{id}.csv` → `id,x,y,z,confidence,n_views`
- `GET /` (+ assets) → the built web app, or a hello page if none is baked in

### WebSocket flow (design doc §7)

```text
client → hello                       server → welcome{sessionId, codeParams}
client → time_sync_ping{t0}          server → time_sync_pong{t0,t1,t2}   (× a few; §7.3)
client → start_mapping{ledCount}     server → mapping_started{patternClockEpoch, codeParams}
client → detections{batch:[…]}       (buffered; no per-batch ack by contract)
client → get_status                  server → status{identified,total,lowParallax}
client → stop_mapping                server → result_ready{mapId}   (after reconstruction)
```

A malformed or unknown message yields `error{code,message}` and keeps the
connection open.

## Design notes / current limitations

- **`patternClockEpoch` is stubbed** to the server clock at `start_mapping`.
  The real epoch comes from the M1 driver's `get_clock()` once M1 lands; the
  seam is `SessionManager.start()`.
- **`status` proxies.** True per-LED parallax needs the geometry, so live status
  reports honest proxies: `identified` = LEDs with ≥2 views (triangulable),
  `lowParallax` = LEDs seen exactly once. Real parallax is computed at
  reconstruction and surfaced in the `OutputMap`.
- **Reconstruction runs in-process** in a worker thread (`asyncio.to_thread`),
  not a subprocess. The seam is the single async callable in `reconstruct.py`;
  swapping to a real subprocess (isolation, cancellation) is a local change.
- **Sessions buffer in memory** and are flushed to disk on `stop_mapping`. A
  crash mid-capture loses the in-flight session; on-disk journaling is a later
  hardening.
- **One session at a time** (MVP). A second `start_mapping` replaces the active
  session.

## Tests

- `//pi/server:server_test` — fast unit tests: code-book derivation, session/map
  store, and the WebSocket message handler (with a stub reconstructor), no socket.
- `//pi/server:server_integration_test` — boots a real uvicorn server and drives
  the full §7 flow over a real WebSocket using M9 simulator detections, then
  reconstructs and serves the map over HTTP. This is the server side of the §6
  M2 acceptance ("a recorded session persists and is reconstructable").
