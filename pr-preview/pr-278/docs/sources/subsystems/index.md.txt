# Subsystems

A guided tour of each component of splanc: what it does, its key files, and the
Bazel targets that build, run, or test it. Start with the {doc}`architecture
<../architecture>` overview for how they fit together.

::::{grid} 1 2 2 2
:gutter: 3

:::{grid-item-card} 📱 The PWA
:link: web
:link-type: doc

`web/` — the phone capture app, the effects editor, and the virtual LED wall.
Framework-free TypeScript on Vite.
:::

:::{grid-item-card} 🔌 The firmware
:link: firmware
:link-type: doc

`firmware/` — `no_std` Rust crates behind a C++/Arduino app on the ESP32-C6:
LEDs, the control server, and the effects VM.
:::

:::{grid-item-card} ✨ The effects compiler
:link: fx-compiler
:link-type: doc

`fx_compiler/` — a single-pass compiler from the effects language to `.fxb`
bytecode, native and wasm.
:::

:::{grid-item-card} 🧮 The solver
:link: solver
:link-type: doc

`solver/` — the visual-inertial solver in Rust: native on the Pi, wasm in a
phone Web Worker.
:::

:::{grid-item-card} 🗺️ Reconstruction
:link: reconstruction
:link-type: doc

`pi/reconstruction/` — triangulation + bundle adjustment that turns detections
into a per-LED 3D map.
:::

:::{grid-item-card} 🔗 The wire protocol
:link: protocol
:link-type: doc

`shared/protocol/` — JSON schemas + protobuf as the single source of truth for
every cross-module message.
:::

:::{grid-item-card} 🧪 The simulator
:link: simulator
:link-type: doc

`shared/simulator/` — synthetic ground truth: fixtures, camera walks, and
degradations for hardware-free testing.
:::

:::{grid-item-card} 🤖 HITL & tooling
:link: hitl
:link-type: doc

`pi/hitl/` + `tools/` — the hardware-in-the-loop rigs and the host-side dev,
flash, and bench helpers.
:::

::::

```{toctree}
:hidden:

web
firmware
fx-compiler
solver
reconstruction
protocol
simulator
hitl
```
