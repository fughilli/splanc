# Design notes

Deep dives and durable rationale — the "why" behind the subsystems. These are the
project's own design docs, folded into the site as-is.

## Effects

```{toctree}
:maxdepth: 1

The effects runtime <../docs/design/effects-runtime>
The effects compiler <../docs/design/effects-compiler>
Performance monitoring <../docs/design/perf-monitoring>
FX decks, crossfade & uniform keypoints <../docs/design/uniform-keypoints>
FX debugger: pause, inspect, replay <../docs/design/fx-debugger>
```

## Capture, solve & reconstruct

```{toctree}
:maxdepth: 1

VIO solver exploration <../docs/vio-exploration>
Blob-detection playbook <../docs/blob-detection-playbook>
ESP32 LED-mapping plan <../docs/esp32-led-mapping-plan>
```

## Firmware memory & verification

Why and how the ESP32-C6 player went from 1.6 KiB to ~87 KiB of worst-case
free heap, and how that is kept true (see also {doc}`../docs/manifesto`).

```{toctree}
:maxdepth: 1

RAM budget <../docs/design/ram-budget>
Memory regions & the mode model <../docs/design/memory-regions>
Post-boot heap census <../docs/design/heap-census>
Kani under Bazel <../docs/design/kani-bazel>
mbedtls dynamic buffers <../docs/design/mbedtls-dynamic-buffers>
```

## Hardware platforms

```{toctree}
:maxdepth: 1

ESP32-P4 + ESP32-C6 split player <../docs/design/p4-c6-split>
```

## Agents & multi-fixture

```{toctree}
:maxdepth: 1

Multi-fixture agent hub <../docs/design/agent-multi-fixture>
Cloud relay + LAN bridge <../docs/design/cloud-relay>
```

## App & platform

```{toctree}
:maxdepth: 1

App UX overhaul <../docs/design/app-ux-overhaul>
iOS support <../docs/design/ios-support>
On-device models <../docs/design/on-device-models>
Effects demo <../docs/design/effects-demo>
```

## Cross-cutting

- {doc}`../docs/decisions` — the decision log: pinned versions and the rationale
  behind them.
- {doc}`../docs/runbook` — bootstrap, lockfile updates, and operational
  procedures.
