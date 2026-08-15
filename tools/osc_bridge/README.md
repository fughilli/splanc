# `osc_bridge` — OSC → uniform control (FUG-121)

Drive a `ledmapper.v1` fixture's live shader uniforms from **OSC** (Open Sound
Control), so any OSC source — TouchDesigner, Ableton (Max for Live), TouchOSC,
Max/MSP, a Python script, a hardware controller behind an OSC app — can move a
uniform in real time, exactly as a slider drag in the web editor does.

```sh
bazel run //tools/osc_bridge:osc_bridge -- \
    --addr 192.168.1.50:81 --listen 0.0.0.0:9000
```

Then point your OSC source at `<this-host>:9000` and send, e.g., `/speed` with a
float. The bridge forwards it to the fixture's active effect.

## How it works

The bridge reuses the TouchDesigner plugin's protocol core
(`//tools/touchdesigner/core`). It opens the same `ws://<host>:81/ws` session the
TD plugin uses, fetches the active effect's **uniform manifest**, and calls
`Session::drive_uniforms` — so slot resolution, vector/colour fan-out, boolean
thresholding and change-detection are all shared with the TD path. The only new
code here is a small, hand-rolled OSC 1.0 parser (no external crate, matching the
repo's hand-rolled protobuf/WebSocket) and the address→channel mapping.

```text
OSC UDP datagram ─▶ parse ─▶ address→channel ─▶ ChannelMap (last values)
                                                      │
                                    drive_uniforms(map) ─▶ manifest ─▶ device
```

The bridge keeps the **last value of every channel**, so components that arrive
in separate messages (a mixer moves one fader at a time) still combine: a lone
`/tint/y` completes the `tint` colour using the `x`/`z` values seen earlier.

## Address convention

An OSC address names a uniform channel on the active effect. The device manifest
names a scalar by its bare name and a vecN's components as `name:x` / `:y` / `:z`
/ `:w`; the bridge strips a configurable prefix (default `/`) and turns the
remaining `/` separators into `:`.

| OSC address (default prefix `/`) | uniform channel | drives                      |
| -------------------------------- | --------------- | --------------------------- |
| `/speed`                         | `speed`         | scalar slider `speed`       |
| `/mirror`                        | `mirror`        | toggle `mirror` (≥0.5 → on) |
| `/tint/x` `/tint/y` `/tint/z`    | `tint:x/y/z`    | colour/vec3 `tint`          |

With `--prefix /uniform/`, send `/uniform/speed`, `/uniform/tint/x`, etc.

The first numeric argument of each message is used (`f` float, `i`/`h` int,
`d` double, or `T`/`F` boolean → 1.0/0.0). Extra arguments and non-numeric
types are ignored, and a non-OSC datagram is dropped.

**No manifest?** Older firmware advertises no manifest; the session then falls
back to `slotN`-style names, so `/slot0` (or `/s0`) addresses raw uniform slot 0.

## Options

| flag                 | default        | meaning                                             |
| -------------------- | -------------- | --------------------------------------------------- |
| `--addr <host:port>` | _(required)_   | fixture WebSocket endpoint (protocol port, e.g. 81) |
| `--listen <ip:port>` | `0.0.0.0:9000` | UDP endpoint to receive OSC on                      |
| `--prefix <p>`       | `/`            | OSC address prefix to strip                         |
| `--effect <id>`      | _(none)_       | activate this effect on the fixture before driving  |
| `-v`, `--verbose`    | off            | log every applied message and dropped datagram      |

## TouchDesigner / TouchOSC quick start

- **TouchDesigner**: an `OSC Out DAT` (or `OSC Out CHOP`) to `<host>:9000`. Send
  channels named `speed`, `tint/x`, … (CHOP channel name becomes the address).
- **TouchOSC**: set the host to this machine and the outgoing port to `9000`;
  name each fader/toggle's OSC address `/speed`, `/mirror`, `/tint/x`, …

## Tests

`bazel test //tools/osc_bridge:osc_bridge_test` covers the OSC parser (messages,
bundles, arg types, garbage rejection) and the address→channel mapping. Driving a
real fixture is a manual/HITL step (there's no OSC-speaking device in CI).
