# Pi 3 (vc4) GLES2 + VM benchmark payload

Step 2 of [docs/design/fx-gpu-lowering.md](../../docs/design/fx-gpu-lowering.md): GLES2
offscreen render + readback on a real Pi 3B+ VideoCore IV, against the fx_vm on
the same Pi, the same kernels and the same LED layouts, up to 20×1024.

## Build (aarch64 host with nix + gcc)

```sh
bazel build -c opt //fx_gpu:fxgpu_pack //fx_gpu:fxvm_bench
fx_gpu/pi3bench/build_payload.sh /workspace/.claude/fxgpu/pi3bench
```

The output directory holds `pi3bench-payload.tar.gz` (~37 MB; ~125 MB unpacked),
`run.sh`, `rig_run.sh`, `summarize.py` and `MANIFEST.txt`.

The payload is self-contained aarch64. It carries:

- a lean Mesa 26 (vc4 + v3d, **no LLVM, no software renderer**), relocated with
  RUNPATHs stripped and the EGL vendor JSON rewritten;
- glibc's loader;
- `gles2bench` (dlopens EGL/GLES);
- a static `fxvm_bench`;
- the packed kernels with VM goldens.

It uses nothing from the image's own GL stack.

## What `run.sh` does on the Pi

It runs read-only: no spidev, no player interaction, no system changes.

1. Unpack into `mktemp -d /var/tmp/fxgpu-pi3bench.XXXXXX`. A trap removes it on exit, error or signal.
2. Print one `env` JSON line: board model, kernel, whether `/dev/dri/renderD128`
   exists, whether the `vc4`/`v3d` modules are loaded, the `config.txt` overlay
   lines, whether the image ships its own Mesa, CMA, free memory, load, CPU
   governor/frequency, throttling, and the player's CPU/RSS.
3. GLES2 (when the render node exists): for each GPU-capable kernel × layout,
   one `gles2` JSON line. Contents:
   - render ms (uniforms + draw + `glFinish`);
   - readback ms (`glReadPixels` RGBA8);
   - readback cost of the implementation's preferred read format and of an
     RGB565 target;
   - a pipelined draw+read loop;
   - byte-exact comparison against the VM golden on frames 0–2.
4. VM: one `vm` JSON line per kernel × layout, giving ms/frame (update + prepare +
   shade every LED) and its own golden check.
5. Print `{"bench":"done"}`.

Kernels:

- **GPU and VM:** `solid_fill`, `gradient`, `sweep`, `imu_tilt`, `cylinder`, `plasma`.
- **VM only** (hash, so no integer ops on GLES2): `noise`, `pulses`.

Layouts (channels × LEDs per channel): `1x500 1x2048 4x550 4x1024 8x1024 16x1024 20x1024`.
The render target is LEDs-per-channel × channels, so 20×1024 renders to 1024×20,
inside vc4's 2048 limit with no tiling.

## Rig-side sequence (operator)

The scripts never place or print the key. The operator supplies it inside the
container and passes its path as `PI_KEY_FILE`. `rig_run.sh` sets it to 0600
and deletes it on exit, including on failure. It also removes the payload from
the Pi and clears any leftover `/var/tmp/fxgpu-pi3bench-*` from an earlier
preempted run before it starts.

Use `pi-ledmapper-2` (splanc-max-1, no Tang, less contended). The GPU bench
doesn't need the FPGA. `pi-ledmapper-1` works too.

```sh
cd /workspace/.claude/fxgpu/pi3bench
export HITL_OWNER=<your-owner-tag> HITL_ACTOR=agent
# KEYNAME = the file name you add to the stream yourself (not done by these scripts).
# One atomic reservation per batch; the container gets the files on stdin and
# removes its own dir afterwards.
batch() {   # $@ = run.sh options for this batch
  tar cf - pi3bench-payload.tar.gz run.sh rig_run.sh KEYNAME |
  hitl reserve --unit pi-ledmapper-2 --host http://hitl-rig-1:8087 -- \
    "sh -c 'D=\$(mktemp -d) && cd \$D && tar xf - && PI_KEY_FILE=\$D/KEYNAME sh rig_run.sh $*; rc=\$?; cd /; rm -rf \$D; exit \$rc'" |
  tee -a pi3bench-results.jsonl
}
batch --kernels solid_fill,plasma
batch --kernels cylinder,imu_tilt
batch --kernels gradient,sweep
batch --no-gpu --kernels noise,pulses
python3 summarize.py pi3bench-results.jsonl
```

Notes:

- Each batch takes about 1–1.5 minutes on the Pi plus about 10–20 s to copy 37 MB,
  so it should fit inside a reservation even if contention preempts it.
- For a quick first look, run `batch --points 1x500,20x1024 --kernels solid_fill,plasma`
  (about 30 s).
- If the queue is short, a single `batch` with no options runs everything in about
  4–5 minutes.
- **Never kill a queued `hitl reserve`.** SIGTERM releases it; a stale entry is
  released with `POST /reservation/<id>/release`.
- The container needs `ssh`, `scp` and `tar`. If they're missing, `rig_run.sh`
  prints `{"bench":"rig","ok":false,"error":"ssh not in container"}` and exits.

## Expected runtime

| Part                                                               | Time                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| scp + unpack (37 MB → ~125 MB on the SD card)                      | ~15–30 s                                              |
| GLES2: 6 kernels × 7 layouts, each ~185 draw+readback passes       | ~1–2 min (_estimate_; vc4 at 20k LEDs is the unknown) |
| VM: 8 kernels × 7 layouts, ≤ 1.5 s budget per point (min 3 frames) | ≤ ~1.5 min                                            |
| **Total**                                                          | **~3–5 min**, or ~1–1.5 min per batch                 |

## What good output looks like

- **env:** `"render_node":"yes"`, `"vc4_module":"yes"`, and `"config_txt"` containing
  `dtoverlay=vc4-kms-v3d`. `"image_has_mesa"` may be `no`; that's fine, because the
  payload brings its own Mesa.
- **gles2:**
  - Every line has `"ok":true` and `"renderer"` contains **`VC4`**. The bundled Mesa
    has no software renderer, so a `llvmpipe` renderer is impossible.
  - `golden_max_err` is `0` for `solid_fill`, `imu_tilt`, `gradient` and `sweep`, and
    small (≤ ~2–6) for `plasma` and `cylinder`. Those use native `sin`; the VM uses a
    LUT sine (class 2 in the numerics policy). On llvmpipe they measure 1/255 on
    ~5–15% of LEDs. **vc4's own number is the finding.**
  - `render_ms_*` and `readback_ms_*` grow with `n`.
- **vm:** `golden_max_err` is `0` on every line. The VM is bit-exact across
  platforms, so anything non-zero is a bug; report it.
- The last lines are `{"bench":"done","ok":true}` and `{"bench":"rig","ok":true,"rc":0}`.

**If there's no vc4:** a `gles2` line saying `no /dev/dri/renderD128 ... GPU bench
skipped` means the MAX image doesn't run the vc4 KMS driver. That is itself the
answer to "is vc4 present". The GPU path then needs an image change
(`dtoverlay=vc4-kms-v3d` + CMA), which this run doesn't make. The VM half still
runs and gives the baseline.

**Other failures:**

- `eglInitialize` / `no ES2 EGL config` / `shader compile failed` lines carry the
  last 600 bytes of stderr in `"error"`. Send the JSON as-is.

## SPI continuity (separate capture, the 20-port FIFO risk)

The question is whether the Pi has gaps between spidev transfers. The FPGA core
buffers only about 2 bytes per port, so a gap longer than about one WS byte-time
underruns it.

To measure, capture rig-1's FX2 SPI tap (MOSI D1, CLK D3, CS D5) on
`pi-ledmapper-1` while the player streams at its normal rate, for example:

```sh
python3 pi/hitl/harness/hitl_fpga_ws281x.py --device pi-ledmapper-1 \
  --num-ports 4 --leds-per-port 1024 --check-spi-stream --spi-channels D3,D1,D5
```

Send the raw capture. 24 MS/s is too slow to decode bits at the player's 6.4–12.8 MHz
SPI clock, but it is enough to time the idle gaps on CLK and CS, and the gap
histogram is what's needed. This is analyzed by hand, not by `run.sh`.
