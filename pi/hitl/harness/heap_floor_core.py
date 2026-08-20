"""Pure logic for the HITL min-free-heap gate (FUG-132).

Split out from the hardware driver (hitl_heap_floor.py) so the verdict and the
worst-case-load plan are unit-testable in //pi/hitl/tests with no rig/network,
the way the other *_core modules pin device/app/harness parity.

FUG-132 background: PR #114's LED-cap bump grew the static strip framebuffer by
~24 KB, and the wss:443 cert page / reconnect then OOMed (`alloc(8866) failed` ->
`esp_tls_create_server_session failed`) — but ONLY with a real map+effect
resident. `heap_min_free` bottomed out at ~1.8-2.7 KB, far below the ~28 KB a
fresh mbedTLS session needs. Nothing in the suite gated on the heap floor, so a
clean-device test sailed through the regression. This gate loads the worst case
and asserts `PerfReport.heap_min_free` clears a floor big enough for a fresh TLS
handshake plus margin."""

from __future__ import annotations

from typing import Any

# A fresh mbedTLS server session on the C6 needs a ~17 KB contiguous record
# buffer plus its working allocations — empirically ~28 KB of free heap for the
# cert-page handshake to complete (see firmware/player_app/ffi.rs and the FUG-71
# heap notes). 30 KB is that handshake cost plus a small margin, and is the
# default floor; tune it from a measured clean-baseline `heap_min_free` once the
# gate has run green on a rig.
DEFAULT_MIN_HEAP_FREE = 30 * 1024


def heap_min_free(report: dict[str, Any]) -> int | None:
    """The `heap_min_free` field from a decoded PerfReport (camelCase in the JSON
    the wire codec emits), or None when the device omitted it. proto3 drops zeros,
    but a real device never reports a literal 0 min-free (it would have crashed),
    so a missing field means the report predates the load or the field is
    unsupported — the caller treats that as a hard error, not a pass."""
    val = report.get("heapMinFree")
    if val is None:
        val = report.get("heap_min_free")
    return int(val) if val is not None else None


def verdict(heap_min_free_bytes: int, floor_bytes: int = DEFAULT_MIN_HEAP_FREE) -> bool:
    """The gate passes iff the worst-case minimum free heap cleared the floor.
    At-floor passes (the floor is the acceptance bar, inclusive)."""
    return heap_min_free_bytes >= floor_bytes


def summarize(report: dict[str, Any], floor_bytes: int) -> str:
    """A one-line human summary of the heap outcome for the driver's PASS/FAIL log
    (bytes rendered as KB to match how the floor is reasoned about)."""
    mf = heap_min_free(report)
    free = report.get("heapFree", report.get("heap_free"))
    mf_kb = "n/a" if mf is None else f"{mf / 1024:.1f} KB"
    free_kb = "n/a" if free is None else f"{int(free) / 1024:.1f} KB"
    return (
        f"heap_min_free={mf_kb} heap_free={free_kb} floor={floor_bytes / 1024:.1f} KB "
        f"(effect={report.get('effectId', report.get('effect_id', '?'))!r})"
    )
