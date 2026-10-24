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

## Rig-side sequence (operator): SSH tunnel through the reservation

The hitl-rig-1 reservation container has **no `tar`**, so the payload can't be
streamed into it. Instead, tunnel the Pi's SSH port through the reservation
with `hitl_client.Reservation.forward(addr, 22)` and drive the Pi from the
operator's host. The key stays on the operator's host and never enters the
container. Nothing is installed on the Pi: the payload lands in
`/var/tmp/fxgpu-pi3bench-*`, `run.sh` unpacks into its own temp dir, and both are
removed.

```python
# python3, with pi/hitl/harness on sys.path; KEY = the operator's Pi key path
import subprocess
from hitl_client import Reservation

SSH = ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no",
       "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]
with Reservation(server="http://hitl-rig-1:8087", owner=OWNER, device="pi-ledmapper-2") as r:
    addr = r.ssh('printf %s "${HITL_ADDRESS:-$HITL_DUT_ADDR}"', capture=True).stdout.strip()
    with r.forward(addr, 22) as port:
        tgt, d = "root@127.0.0.1", "/var/tmp/fxgpu-pi3bench-op"
        sh = lambda cmd, **kw: subprocess.run(["ssh", "-p", str(port), *SSH, tgt, cmd], **kw)
        try:
            sh(f"rm -rf /var/tmp/fxgpu-pi3bench-* && mkdir -p {d}", check=True)
            subprocess.run(["scp", "-P", str(port), *SSH, "pi3bench-payload.tar.gz", "run.sh",
                            f"{tgt}:{d}/"], check=True)
            with open("pi3bench-results.jsonl", "a") as out:
                sh(f"sh {d}/run.sh {d}/pi3bench-payload.tar.gz --vm-threads 1,4", stdout=out)
        finally:
            sh(f"rm -rf {d}")
```

A full run takes about 4–6 minutes with `--vm-threads 1,4`. It fits one
reservation when uncontended. Under contention, split it with `--kernels a,b`.
Then run `python3 summarize.py pi3bench-results.jsonl`.

`rig_run.sh` (stream the files into the container, then scp from there) is kept
for rigs whose container has `tar`, `ssh` and `scp`. **hitl-rig-1's doesn't.**

**Never kill a queued reservation.** SIGTERM releases it; a stale entry is
released with `POST /reservation/<id>/release`.

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

The question is whether the Pi pauses inside a STREAM transfer. The FPGA core
has a per-port BSRAM FIFO (1,659 B in-tree; 2,048 B in the #370 20-port variant).
It starts emitting once every port holds `PREFILL` bytes (default 2), so the
risky window is **right after a frame starts**. There the only slack is about
`PREFILL × 10 µs`, and a longer pause latches the strip mid-frame. Mid-frame the
FIFO has built a lead and absorbs pauses of hundreds of µs (#370 sim).

That measurement now lives with the FPGA work, in #370:

- `//pi/hitl/harness:spi_continuity` (`hitl_spi_continuity.py`): an FX2 CLK + CS
  timing capture through the rig's shared analyzer, sweeping the transfer size.
  It is valid only at SCK ≤ 6.4 MHz with pauses ≥ 1 µs: the 24 MS/s analyzer can't
  decode SPI and aliases near 2 × SCK.
- The core's own `STATS` counters (underruns, `max_byte_gap`, `min_fill`).

It needs no Pi credentials, and `run.sh` doesn't do it.
