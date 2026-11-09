# FX debugger: pause, inspect and replay the device's effect engine

Sometimes a fixture doesn't look like the effect workspace's preview. The FX
debugger answers why. It pauses the FX engine on the device, reads back what the
device rendered and the VM state behind it, and replays the same frame on the
host with the same VM. If the device and the replay agree, the cause is in the
inputs or the output stage. If they disagree, the cause is in the engine itself.

It is available in three places:

- **Firmware** (`firmware/player_app/fxdbg.rs`): three protocol arms.
- **Effect workspace** (Debugger pane): pause and step controls, a device-vs-preview
  diff in the 3D preview, and an inspector for a clicked LED.
- **Agent bridge** (MCP tools): `pause_fx`, `step_fx`, `snapshot_fx`,
  `compare_with_preview` and `resume_fx`.

Both hosts share one implementation, `web/src/fx/fxDebug.ts`, so they reach the
same verdict.

## Protocol

| Client arm | Reply (`ServerMessage.fx_debug`) | What it does |
| --- | --- | --- |
| `fx_debug_control{action, frames, dt, to_time, hold_ms}` | `state` | `STATUS`, `PAUSE`, `RESUME` or `STEP` (N frames at a fixed `dt`, or one frame at exactly `to_time`) |
| `get_fx_snapshot{section, deck, offset, max_len}` | `chunk{total_len, offset, data, frame, paused}` | One byte window of a snapshot section |
| `debug_fx_led{led, deck, max_locals}` | `led{rgb, rgb_jit, output, locals, led_context, instructions, stack_max}` | Re-runs one LED of the paused frame and returns its VM locals |

All three replies share one envelope arm, `fx_debug` (`FxDebugReply`). Each extra
`ServerMessage` arm adds a by-value slot to every decode frame in the debug host
builds, and three of them pushed `//firmware/ota:wire_test` past its stack.

Firmware without the debugger doesn't advertise the `fx_debug` feature in
`welcome.features`. The Pi player answers `error{unsupported}`.

### The pause is a lease

- `PAUSE` freezes the frame clock: `time` stops, nothing renders, and the strip
  latches the last frame.
- `RESUME` continues from the frozen time. A shared time base (`set_time_base`)
  re-applies on the next frame.
- The engine auto-resumes in two cases:
  - `hold_ms` (default 120 s, at most 600 s) after the last debugger message;
    every debugger message renews the lease;
  - about 5 s after the last debugger message when no session is open
    (`lm_fxdbg_poll`, which the loop task runs).
- `fx_debug.state.resume_reason` reports `timeout` or `disconnect`, so a fixture
  never stays frozen.
- A mapping capture or the counting probe still preempts a paused engine.
- A step renders through the normal path (update, shade, output stage, wire). It
  skips only the framerate autoscaler and the perf ring.

### Snapshot sections

All sections are little-endian and are streamed from the live buffers. The
handler writes each window straight into the reply buffer, so there are no copies
and no allocation on the device. Each window is at most 1536 B; the clients use
768 B.

| Section | Layout |
| --- | --- |
| `OUTPUT` | Per LED: R, G, B as the strip shows them, after the LUT and brightness (the `leds` buffer) |
| `WIRE` | Per LED: 3 bytes in wire order (each channel's colour-order permutation) |
| `UNIFORMS` | `MAX_UNIFORM_SLOTS` (128) × f32 |
| `STATE` | 128 × f32 `state` slots, then the `flood_from` field: 96 × f32 node distances, f32 max, u32 set (`Vm::FLOOD_WORDS`) |
| `ARENA` | The deck's buffer arena: `arena_need(prog)` bytes, the bytes its program addresses |
| `PROGRAM` | The `.fxb` as uploaded. The JIT patches are undone; the 3 bytes each `JitCall` replaced are kept in `FX_JIT_ORIG`. |
| `LED_CONTEXT` | Per LED: one `FX_LED_V1` record |
| `LUT` | 3 × 256 bytes (R, G, B), or empty when no LUT is applied |
| `RAW` | Per LED: the blended effect colour before the LUT, recomputed at the paused frame. Paused only. |
| `GRAPH` | u32 `n_seg`, then per segment: f32 length, i32 node a, i32 node b |

`FX_FRAME_V1` (`fx_debug.state.frame_ctx`, 124 B) holds the 31 words of the
`shade()` `Frame`, in this order:

- `time`, `dt`, `frame`, `led_count`
- `imu_accel[3]`, `imu_gyro[3]`
- `time_fix`, `dt_fix`, `imu_accel_fix[3]`, `imu_gyro_fix[3]`
- `room_posed`, `room_min[3]`, `room_max[3]`, `room_min_fix[3]`, `room_max_fix[3]`

`FX_LED_V1` (44 B) holds the `Led` that `shade()` gets:

- `pos[3]`, `s`, `dist`, `uv[2]`, `room[3]` (f32)
- `seg` (i16)
- `branch` (u8)
- `flags` (u8): bit 0 = the LED has a map entry; bit 1 = its position was measured
  rather than interpolated

The Q16.16 mirrors are not sent. They are `(x * 65536.0) as i32` of these values,
exactly as the firmware builds them.

These layouts have one source of truth, `ledmapper_fx_vm::dbg`. The firmware
writes through its encoders and the host replays decode through the same module.

### Memory cost on the C6

| | Before | After |
| --- | --- | --- |
| Static RAM | — | ~60 B of debugger state + 48 B to keep the JIT-patched bytes (`FX_JIT_ORIG`) |
| Heap | — | 0 (no new allocations) |
| loopTask stack bound (`//firmware/player_app:stack_bound_test`) | not re-measured on main | 9344 B, against a 14336 B reservation; the largest new frame is the 128 B per-LED buffer save |
| Flash | — | ~13 KB of code |

## Re-running a LED without side effects

`debug_fx_led` runs `shade()` twice for one LED:

1. The normal path, JIT included. This gives `rgb_jit`.
2. The interpreter, with the JIT patches swapped out and the scratch zeroed. This
   gives `rgb` and `locals`. A local the run never wrote reads 0.

Effects can write their own LED's buffer element in `shade()` (`trail[led.idx]`).
Before each run, the LED's per-LED buffer elements are saved
(`dbg::led_elem_ranges`) and restored after it. This has two effects:

- Both runs see the paused frame's buffers, so the JIT and the interpreter
  compare fairly.
- The paused state stays exactly as it was.

The host replay does the same. Two limits apply:

- An effect that writes other LEDs' elements, or `paint()`s a texture, is not
  restored.
- Locals the optimizer kept on the operand stack (store-then-return) are never
  written, so they read 0.

## Host replay and `compare_with_preview`

`compareWithPreview` (in `fxDebug.ts`) does the following:

1. Pause the engine if it is running.
2. Snapshot the paused frame: program, state and buffers per rendering deck.
3. `STEP` one frame.
4. Snapshot that frame: uniforms, state, buffers, graph, per-LED inputs, output,
   LUT and frame context.
5. Replay the frame with `FxReplay`, the wasm build of the firmware VM:
   - restore the pre-step state, buffers and `flood_from` field;
   - set the frame's uniforms, graph and `FX_FRAME_V1`;
   - run `update()`;
   - `shade()` every LED from its own `FX_LED_V1` record;
   - blend the decks with the firmware's own `blend_rgb8`, then apply the output
     stage.

The result is classified as follows.

| Verdict | Meaning | What it points at |
| --- | --- | --- |
| **ENGINE** | The device's output, post-frame state or buffers differ from the replay, given the same program and inputs | A VM, JIT or firmware bug. The report adds the first divergent LEDs' locals (the device's interpreter vs the host's identical re-run) and flags a `JIT` disagreement when the device's normal path differs from its interpreter. |
| **INPUTS** | The preview builds different `shade()` inputs for the same LED: map positions (the device stores F24), topology `seg`/`s`/`dist`, `uv`, or the LED order. The preview indexes by map-list position, the device by LED id. | A map or data mismatch. Each differing LED is re-shaded on the post-frame VM both ways, and the report lists which locals the input difference moves. |
| **OUTPUT STAGE** | Brightness or the colour LUT change what the strip shows; the preview shows the raw effect colour | The output stage. The wire colour order per channel is always reported. |
| **MATCH** | None of the above | The physical side: the strip's real colour order, LED type, wiring or power. |

VM slots get names from the compiler's symbol table (`Compiled::symbols`,
`fx_compile(...).symbols`): state variables, locals, parameters and buffers by
slot. The names apply only when the host's source compiles to exactly the
device's program (FNV-1a `fxb_hash`).

`//firmware/fx_vm:fx_replay` is the same replay as a command-line tool. It takes
the snapshot files and writes the output, state, buffers and locals. The HITL
gate uses it so the lane needs neither a browser nor node.

## Tests

| Test | What it checks |
| --- | --- |
| `//firmware/player_app:fx_debug_test` | Through the C ABI: pause, hold, steps and the lease; chunked sections reassemble at any window size; a host replay matches the device bit-exactly through the LUT and brightness, for float/state/buffer-feedback and fixed-point effects; per-LED locals match the host; `debug_fx_led` leaves the buffers untouched; and `fx_replay` reproduces the frame |
| `//web:fxDebug_test` | Arm round-trips, the layouts, the output stage, chunking over a single-flight link, and the classification against a fake device |
| `//agent:fxdebug_test` | The MCP tools against a fake player that emulates the debugger on the real VM wasm: a faithful device replays bit-exactly with F24 positions as inputs; an injected per-LED fault is pinned with named locals and a JIT disagreement |
| `//pi/hitl/harness:fx_debug_netstack` (HITL) | On a real C6 with the JIT on: four effects replay bit-exactly (output, state, buffers, locals), an exact-time step lands exactly, and the engine auto-resumes on a lapsed hold and after a disconnect |
