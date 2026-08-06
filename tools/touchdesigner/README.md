# TouchDesigner custom operators (FUG-78)

Two TouchDesigner Custom Operators for driving `ledmapper.v1` LED fixtures from
TouchDesigner over the LAN:

- **LedMapper Texture** (a **TOP**) — streams the pixels of its input TOP to a
  fixture's texture input port (video textures for effects).
- **LedMapper Uniforms** (a **CHOP**) — drives an effect's shader uniforms
  (`float`, `bool`, `vecN`) from its input CHOP channels.

Both discover/enumerate fixtures on the local network and speak the exact same
binary protobuf protocol the phone/web app uses (`shared/protocol/proto/
ledmapper.proto`), over the player firmware's plain WebSocket endpoint
`ws://<host>:81/ws`. (A native plugin has none of a browser's mixed-content
constraints, so it uses `ws:81` and skips the `wss:443` TLS path entirely.)

## Layout

| Path      | What                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`   | `td_ledmapper` — the Rust native core (protocol, texture codec, uniform-manifest parsing, discovery, WebSocket client, non-blocking session, C ABI). Fully unit-tested on the host. |
| `plugin/` | The C++ TOP/CHOP shims over the TD SDK; thin translators to the Rust FFI.                                                                                                           |
| `tox/`    | Packaging: `build_tox.py` (the in-TouchDesigner `.tox` finalizer) + `mk_tox.py` (Bazel bundler).                                                                                    |

## Architecture

TouchDesigner cooks operators on a real-time thread that must never block on the
network. So the C++ shim only ever reads TD's input pixels/channels and forwards
them through a C ABI into a Rust [`Session`](core/src/client.rs), which owns a
**background worker thread** holding the WebSocket connection. The worker
coalesces the latest frame / uniform values (so a slow link drops frames instead
of stalling the cook), auto-reconnects, and fetches the effect's uniform
manifest. All protocol/codec/discovery logic lives in Rust so it is testable
without TouchDesigner:

```sh
bazel test //tools/touchdesigner/core:td_ledmapper_test
```

### Discovery / enumeration

The firmware exposes a stable `ledmapper.local` hostname and its protocol on
port 81 (it does not yet advertise an mDNS service). `tdlm_discover_json` probes
explicit hosts, `ledmapper.local`, and — optionally — every host on the local
`/24`, reading each `welcome` for its MAC + display name. Texture ports and
uniforms are enumerated from the effect's manifest returned by
`get_effect_uniforms`; see the caveat below.

### Uniform mapping (CHOP)

Each input channel's most-recent sample is read as a value and mapped onto a
uniform slot:

- With a manifest: a scalar/bool uniform consumes the channel named exactly
  after it; a `vecN` uniform consumes `name:x`, `name:y`, `name:z`(`:w`).
  Booleans threshold at 0.5.
- Without a manifest (see caveat): a channel named `slotN` (or `sN`, or a bare
  integer `N`) drives scalar uniform slot `N`.

## Build & install

### Core (any platform, incl. CI)

```sh
bazel test //tools/touchdesigner/core:td_ledmapper_test
bazel build //tools/touchdesigner/core:td_ledmapper_ffi   # C-ABI static lib
```

### Plugins (macOS / Windows only)

TouchDesigner runs only on macOS and Windows, so the plugin and packaging
targets are platform-gated (Linux CI skips them). On a Mac/Windows box with the
TouchDesigner SDK reachable (fetched via the `@touchdesigner_sdk` archive):

```sh
bazel build //tools/touchdesigner/plugin:ledmapper_texture
bazel build //tools/touchdesigner/plugin:ledmapper_uniforms
```

Then either drop the built plugin into your TouchDesigner **Plugins** folder
(Windows: `Documents/Derivative/Plugins`; macOS: `~/Library/Application
Support/Derivative/TouchDesigner*/Plugins`), or package a portable bundle:

```sh
bazel build //tools/touchdesigner/tox:ledmapper_texture_tox
bazel build //tools/touchdesigner/tox:ledmapper_uniforms_tox
```

Each bundle contains the plugin, `build_tox.py`, and install notes. A genuine
`.tox` is TouchDesigner's own component format and can only be written _by_
TouchDesigner, so `build_tox.py` is the final step — run it inside TouchDesigner
to wrap the operator in a COMP, embed the plugin via VFS, and save the `.tox`.

## Parameters

**LedMapper Texture (TOP):** `Host`, `Texture Port` (tex_index), `Format`
(RGB565/RGB888/RGB332/Gray8), `RLE Compress`, `Activate Effect`, `Active`.

**LedMapper Uniforms (CHOP):** `Host`, `Activate Effect`, `Active`.

## Caveats / follow-ups

- **The C++ shim and `.tox` packaging are authored against the documented TD
  SDK API but have not been compiled against the SDK or run inside
  TouchDesigner here** (no SDK/TD/hardware in CI). The Rust core is fully
  tested. Validate the plugin in TouchDesigner against a real fixture.
- **Device-side enumeration depends on the fixture embedding a uniform
  manifest.** Current firmware leaves the embedded manifest empty (and caps the
  `effect_uniforms.manifest` field at 64 bytes), so auto-enumeration returns
  nothing and the CHOP falls back to `slotN` channel names. Populating the
  manifest end-to-end (fx_compiler + a larger firmware cap) is a follow-up —
  kept out of this change to avoid a hardware-untestable core/runtime change.
- `@touchdesigner_sdk` is fetched unpinned (no `sha256`); pin a commit +
  integrity for a reproducible SDK fetch.
