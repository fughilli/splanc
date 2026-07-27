# testdata

Synthetic fixtures for manual + automated testing.

## `synthetic_y_junction.binpb`

A `ledmapper.v1.MappingBundle` (the `.binpb` map format the app imports/exports):
a 3-arm **Y** fixture — 30 LEDs on three straight arms (10 / 12 / 8 LEDs at a
5 cm pitch) meeting at **one branch point** (a degree-3 junction) at the origin,
in the XY plane, `gravity_leveled` frame. Deterministic (no jitter).

Use it to exercise junction-aware behavior — pulse split / flood at a fork,
topology rendering, `submit_effect` over a mapped fixture, MapStore import.

- **In the app:** Maps tab → Import `.binpb` → pick this file (or drag it in).
  Then open it → Effects to preview, or push to a connected device.
- **Regenerate:** `python3 tools/gen_synthetic_map.py`
- **Inspect:** `bazel run //tools/toolchains:protoc -- \
--decode=ledmapper.v1.MappingBundle -I shared/protocol/proto \
shared/protocol/proto/ledmapper.proto < testdata/synthetic_y_junction.binpb`
