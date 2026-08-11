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

| Path                   | What                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`                | `td_ledmapper` — the Rust native core (protocol, texture codec, uniform-manifest parsing, discovery, WebSocket client, non-blocking session, C ABI). Fully unit-tested on the host. |
| `plugin/`              | The C++ TOP/CHOP shims over the TD SDK; thin translators to the Rust FFI.                                                                                                           |
| `tox/`                 | Packaging: `build_tox.py` (the in-TouchDesigner `.tox` finalizer) + `mk_tox.py` (Bazel bundler).                                                                                    |
| `plugin/td_plugin.bzl` | Packages each shim into the format its host TD loads: a `.plugin` **bundle** on macOS, a bare `.dll` on Windows (see below).                                                        |

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
bazel build --config=td //tools/touchdesigner/plugin:ledmapper_texture
bazel build --config=td //tools/touchdesigner/plugin:ledmapper_uniforms
```

Each target resolves, per host OS, to the artifact TouchDesigner actually loads
(this is the packaging the reference CMake build produced, replicated in Bazel
by [`td_plugin.bzl`](plugin/td_plugin.bzl)):

- **macOS** → a `LedMapperTexture.plugin` bundle (a directory with
  `Contents/Info.plist` + `Contents/MacOS/LedMapperTexture`). TouchDesigner on
  macOS loads `.plugin` bundles from the Plugins folder; a bare `.dylib` is
  ignored — this is the difference from a plain `cc_binary(linkshared)` output.
- **Windows** → a bare `.dll`, which TD loads directly.

The shim links no TouchDesigner library — the SDK is header-only for
building a Custom OP (TD passes everything in through runtime pointers), so the
macOS bundle has no undefined TD symbols and needs no TD `.lib`/`.dylib`.

**External toolchains / flags.** Two toolchains can't be vendored into the repo:

- **Xcode / Command Line Tools** (macOS) compile the C++ and emit the bundle.
  Bazel's apple toolchain autodetects them; select a specific Xcode with
  `DEVELOPER_DIR=…` or `xcode-select -s`. `--config=td` pins the deployment
  target to match the bundle's Info.plist (`LSMinimumSystemVersion 10.14`).
- The **TD SDK headers** are fetched by default as `@touchdesigner_sdk`. To
  build against a local checkout instead, bring it into the workspace:

  ```sh
  bazel build --config=td \
    --override_repository=touchdesigner_sdk=/path/to/CustomOperatorSamples \
    //tools/touchdesigner/plugin:ledmapper_texture
  ```

Then either drop the built plugin into your TouchDesigner **Plugins** folder
(Windows: `Documents/Derivative/Plugins`; macOS: `~/Library/Application
Support/Derivative/TouchDesigner*/Plugins`) — copy the whole `.plugin` bundle on
macOS — or package a portable bundle:

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
(RGB565/RGB888/RGB332/Gray8), `RLE Compress`, `Fallback Width`/`Fallback
Height`, `Activate Effect`, `Active`.

### Texture size: auto-probe + rescale

The firmware **silently drops** any `set_texture` frame whose width/height don't
match the effect's declared texture (`firmware/player_app/ffi.rs`), so sending a
1280×720 TOP into a 24×24 effect shows nothing with no error. To make this
visible and automatic:

- On connect (and after `Activate Effect`), the core reads the active effect's
  declared textures from the `effect_uniforms` reply (`TexturePort{index, width,
height, elem}`, added to `ledmapper.proto`) and picks the one matching the
  configured `Texture Port`.
- Each frame is **nearest-neighbour rescaled** to that size before it's
  quantized/sent — so any input TOP resolution "just works".
- If the device advertises no size (older firmware), the core falls back to the
  `Fallback Width`/`Fallback Height` params; `0` leaves frames pass-through.

The node's **Info DAT** (`connected`, `device_name`, `input_res`, `device_res`,
`target_res`, `status`, `frames_sent`, `error`) and **Info CHOP**
(`device_w/h`, `input_w/h`, `target_w/h`, `mismatch`, `frames_sent`,
`connected`) report all of this, and the node raises a **warning** when the
input resolution doesn't match the device's declared texture (it's being
rescaled).

**LedMapper Uniforms (CHOP):** `Host`, `Activate Effect`, `Active`.

## Caveats / follow-ups

- **The C++ shim, the `.plugin`/`.dll` packaging, and the `.tox` step are
  authored against the documented TD SDK API and the reference
  CustomOperatorSamples build, but have not been compiled against the SDK or run
  inside TouchDesigner here** (TD builds only on macOS/Windows, and CI is
  Linux — the plugin targets are platform-gated off). The Rust core is fully
  tested. Validate on a Mac/Windows box against a real fixture. One nuance to
  confirm there: the macOS bundle embeds the `cc_binary(linkshared)` output,
  which is an `MH_DYLIB`; the reference CMake `MODULE` build emits an
  `MH_BUNDLE`. TouchDesigner loads Custom OPs with `dlopen`, which accepts
  both, so the `.plugin` directory + `Info.plist` is the part that matters — but
  if a specific TD build rejects the dylib filetype, switch the `cc_binary` to a
  `-bundle` link (drop `linkshared`, add `linkopts = ["-bundle"]`).
- **Uniform enumeration depends on the fixture embedding a uniform manifest.**
  Current firmware leaves the embedded manifest empty (and caps the
  `effect_uniforms.manifest` field at 64 bytes), so uniform auto-enumeration
  returns nothing and the CHOP falls back to `slotN` channel names. Populating
  the manifest end-to-end (fx_compiler + a larger firmware cap) is a follow-up.
  Note the **texture** dimensions (`effect_uniforms.textures`) do NOT depend on
  the manifest — the firmware derives them from the program's buffer descriptor
  table, so the TOP's size auto-probe works on firmware built with that field
  even while the uniform manifest is still empty. Older firmware that predates
  the field reports no textures; the TOP then uses its `Fallback Width/Height`.
- `@touchdesigner_sdk` is fetched unpinned (no `sha256`); pin a commit +
  integrity for a reproducible SDK fetch.

## License

This directory — the TouchDesigner client binding (Rust protocol core, C++
shims, and packaging) — is licensed under the **MIT License** (see
[`LICENSE`](./LICENSE)), a deliberate carve-out from the AGPL-3.0 that covers
the rest of the repository. It speaks the same `ledmapper.v1` wire protocol as
the phone/web app, and is MIT-licensed so anyone can use or fork it to drive
compatible fixtures without the copyleft obligations that apply to the Splanc
application. See the repository's [`LICENSING.md`](../../LICENSING.md) for the
full map.
