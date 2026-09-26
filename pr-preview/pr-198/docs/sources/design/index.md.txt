# Design notes

Deep dives and durable rationale — the "why" behind the subsystems. These are the
project's own design docs, folded into the site as-is.

## Effects

```{toctree}
:maxdepth: 1

The effects runtime <../docs/design/effects-runtime>
The effects compiler <../docs/design/effects-compiler>
Performance monitoring <../docs/design/perf-monitoring>
```

## Capture, solve & reconstruct

```{toctree}
:maxdepth: 1

VIO solver exploration <../docs/vio-exploration>
Blob-detection playbook <../docs/blob-detection-playbook>
ESP32 LED-mapping plan <../docs/esp32-led-mapping-plan>
```

## Firmware & platform

```{toctree}
:maxdepth: 1

mbedtls dynamic buffers <../docs/design/mbedtls-dynamic-buffers>
App UX overhaul <../docs/design/app-ux-overhaul>
```

## Cross-cutting

- {doc}`../docs/decisions` — the decision log: pinned versions and the rationale
  behind them.
- {doc}`../docs/runbook` — bootstrap, lockfile updates, and operational
  procedures.
