# Sim Studio — interactive solver debugging

A developer tool to **see the reconstruction algorithm working in real time**.
Generate a 3D LED fixture, fly a camera around it to synthesize captures, and
watch the **real M3 solver** converge against ground truth — with per-LED error,
parallax, and reprojection stats updating as you add views.

It is not a shipping module. It reuses the actual pipeline so what you debug is
the real thing:

- **M9** `make_fixture` builds the ground-truth geometry and `NoiseModel`
  injects the same degradations the simulator uses;
- the **shared M3 camera model** (`look_at_quat` + `project`) turns a camera pose
  into detections, in the exact WebXR convention the solver expects;
- **M3** `reconstruct` solves; the studio then scores every solved LED against
  the known truth.

## Run

```sh
bazelisk run //tools/sim_studio:serve   # binds 0.0.0.0:8090 by default
# open http://localhost:8090
```

### Reaching it from your host (claude-container)

`.claude-container-overlay` declares `# claude-container:port 127.0.0.1:8090:8090`,
so after a **container restart** the studio is reachable at `http://localhost:8090`
on the host machine. The server defaults to binding `0.0.0.0` (required for the
Docker port mapping to reach it); pass `--host 127.0.0.1` to keep it
container-local. To reach it from another device on your LAN (e.g. a phone), drop
the `127.0.0.1:` prefix on the port directive in the overlay.

The Python API is fully local; the front-end loads Three.js from a CDN, so the
**browser** needs internet access. (To vendor Three.js for offline use, drop the
two ESM files next to `app.js` and adjust the import map in `index.html`.)

## Using it

1. **New scene** — pick a fixture (line/grid/cube/helix), LED count, and scale.
   Ground-truth LEDs render in green.
2. **Capture** — orbit to a viewpoint and click _Capture view_: the LEDs the
   camera sees become detections and a frustum is drawn. Or click **Auto-arc** to
   place a whole sweep of views automatically (mirrors the real arc walk).
3. **Solve** — runs M3 on the accumulated detections. Solved LEDs render colored
   by error (green = accurate → red = far from truth) with red lines to their
   true positions. _Auto-solve after capture_ re-solves on every new view, so you
   watch the fit tighten as coverage grows.
4. **Noise** — dial in pixel / pose / dropout noise per capture to see how the
   solver degrades; **Min views / Min parallax** expose the solver's gates.

The stats panel shows views, detections, solved/total, mean & max ground-truth
error (mm), global reprojection RMS (px), median parallax, and solve time.

### Things to probe

- A near-straight (small-arc) capture set → low parallax → watch confidence and
  error blow up (the degenerate case the production UI rejects).
- Crank pose noise vs pixel noise to see which the bundle adjustment tolerates.
- Compare fixtures: planar `grid`/`line` need the vertical sweep for out-of-plane
  parallax; `cube`/`helix` are easier.

## HTTP API

| Endpoint                               | Body                                     | Returns                                        |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `POST /api/scene`                      | `{fixture, leds, scale}`                 | ground-truth LED positions + centroid/span     |
| `POST /api/capture`                    | `{eye, target, hfov, imgW, imgH, noise}` | visible/added counts, pose, K                  |
| `POST /api/solve`                      | `{minViews, minParallaxDeg, huberDelta}` | OutputMap + per-LED ground-truth error + stats |
| `POST /api/reset`                      | —                                        | clears captures (keeps the scene)              |
| `GET /api/fixtures` · `GET /api/state` | —                                        | fixture list · current counts                  |

## Tests

- `//tools/sim_studio:studio_test` — the core (`StudioSession`: scene → capture →
  solve, scored vs truth; zero-noise arc recovers < 1 mm; noise increases error)
  and an HTTP integration test that boots a real server and drives the full
  scene → arc → solve flow, asserting the same accuracy and that `/` serves the
  app.
