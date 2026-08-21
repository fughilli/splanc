"""Pure verdict logic for the JIT-on soak test (FUG-135): decide whether a
FULL-perf soak of a JIT-able effect stayed healthy, from the DUT's serial log +
the PerfReports streamed over the player WebSocket. No hardware, no network —
split out of hitl_jit_soak.py so the serial parsing + pass/fail rules are
unit-tested without a rig (the harness supplies the real serial + reports).

The shipped firmware runs the on-device JIT by default (PR #114); `e2e` boots +
onboards but never loads a JIT-able effect or runs under sustained load, so a
JIT-enabled stability regression (a fault, a watchdog reboot, a W^X trap, a
runaway heap) wouldn't be caught. This soak loads a real effect, drives
`set_perf FULL` for ~30 s, and asserts:

  * no reboot / fault: no `Guru Meditation`, no watchdog (TG*WDT / task_wdt), no
    extra app-boot banner mid-soak, and the player socket never dropped;
  * `update=ok` throughout: the firmware's ~1 Hz `[fx] … update=<oc>
    shade_cancelled=<bad>/<n>` render line stays `ok` with zero cancelled shades
    (the FX VM never tripped its bounded-exec budget / wall-time deadline);
  * `heap_min_free` stays stable: the PerfReport low-water mark is populated,
    holds above a floor, and isn't still trending down at the end of the window
    (no ongoing leak) — overlaps with the heap-floor gate.

Reboot is caught two independent ways: the driver seeing the WebSocket drop
(ws_dropped) and the serial showing a fault marker or a second boot banner. That
redundancy matters because the observed failure — the DUT watchdog-rebooting
under FULL perf during fx_bench sweeps — can surface as either.
"""

from __future__ import annotations

import re
from typing import Any

# The interpreter diagnostic main.cpp prints ~1 Hz whenever an effect renders:
#   [fx] t=12.34 frame=370 update=ok shade_cancelled=0/200
# `update` is the VM's last-update outcome (ok / budget / timeout); the fraction
# is how many of the frame's per-LED shades the bounded-exec guard cancelled.
_FX_LINE_RE = re.compile(
    r"\[fx\]\s+t=([\d.]+)\s+frame=(\d+)\s+update=(\w+)\s+shade_cancelled=(\d+)/(\d+)"
)

# The app-boot banner (provision.BOOT_MARKER); printed once per boot. Opening the
# C6's USB-CDC serial resets the chip once, so a serial capture taken across the
# soak legitimately contains exactly ONE of these (the monitor-attach reset) — a
# second means the DUT rebooted mid-soak.
BOOT_BANNER = "SPI_FAST_FLASH_BOOT"

# Crash / watchdog signatures. These are printed ONLY on a fault-reboot (never on
# a clean USB reset), so any occurrence is a hard failure. Kept explicit rather
# than a bare "wdt" substring so an innocent log line can't trip it.
FAULT_MARKERS = (
    "Guru Meditation",
    "Backtrace:",
    "TG0WDT",
    "TG1WDT",
    "task_wdt",
    "Task watchdog",
    "Interrupt wdt",
    "RTC_WDT",
    "rtc_wdt",
    "abort() was called",
    "assert failed",
    "CORRUPT HEAP",
    "Cache disabled",
    "StoreProhibited",
    "LoadProhibited",
    "IllegalInstruction",
    "InstrFetchProhibited",
    "Stack canary",
    "stack smashing",
)


def _field(d: dict[str, Any], *names: str) -> int:
    """First present, nonzero int among `names`. proto_wire.decode_server emits
    camelCase JSON (heapMinFree, droppedFrames); recorded/hand-authored samples
    may use the proto snake_case names — accept both (mirrors fx_bench_core)."""
    for n in names:
        v = d.get(n)
        if v:
            return int(v)
    return 0


def parse_fx_lines(serial: str) -> list[dict[str, Any]]:
    """Every `[fx] … update=… shade_cancelled=b/n` render line in the serial, as
    {t, frame, update, cancelled, leds}."""
    out: list[dict[str, Any]] = []
    for m in _FX_LINE_RE.finditer(serial or ""):
        out.append(
            {
                "t": float(m.group(1)),
                "frame": int(m.group(2)),
                "update": m.group(3),
                "cancelled": int(m.group(4)),
                "leds": int(m.group(5)),
            }
        )
    return out


def find_fault_markers(serial: str) -> list[str]:
    """The distinct crash/watchdog signatures present in the serial (in the fixed
    FAULT_MARKERS order), if any."""
    text = serial or ""
    return [mk for mk in FAULT_MARKERS if mk in text]


def heap_min_free_series(perf_samples: list[dict[str, Any]]) -> list[int]:
    """The populated (>0) heap_min_free low-water marks from the soak's
    PerfReports, in order."""
    series = [_field(s, "heapMinFree", "heap_min_free") for s in perf_samples]
    return [h for h in series if h > 0]


def _dropped_totals(perf_samples: list[dict[str, Any]]) -> dict[str, int]:
    """Sum the since-drain instability counters across the soak's reports (each
    report carries the counts accrued since the previous poll drained the ring)."""
    total = {"droppedFrames": 0, "overruns": 0, "samplesDropped": 0}
    for s in perf_samples:
        total["droppedFrames"] += _field(s, "droppedFrames", "dropped_frames")
        total["overruns"] += _field(s, "overruns")
        total["samplesDropped"] += _field(s, "samplesDropped", "samples_dropped")
    return total


def evaluate_soak(
    serial: str,
    perf_samples: list[dict[str, Any]],
    *,
    ws_dropped: bool,
    serial_captured: bool = True,
    expected_boots: int = 1,
    min_fx_lines: int = 10,
    min_heap_samples: int = 3,
    heap_floor_bytes: int = 0,
    heap_drift_bytes: int = 4096,
) -> dict[str, Any]:
    """Decide whether the soak stayed healthy.

    Signals:
      * ws_dropped — the driver's player socket closed during the soak (a reboot /
        fault under load drops it). Independent of the serial capture.
      * serial — the DUT serial captured across the soak; parsed for fault markers,
        extra boot banners, and the `[fx]` render outcome. When `serial_captured`
        is False (e.g. a --device-ws run with no rig serial), the serial-only
        checks are skipped and only the WS + heap signals gate.
      * perf_samples — the PerfReports polled over the soak; source of the
        heap_min_free stability check + the instability counters.

    `expected_boots` is how many BOOT_BANNER lines the capture may legitimately
    contain (1 for the monitor-attach reset that precedes the soak). Returns
    {ok, failures, warnings, stats}."""
    failures: list[str] = []
    warnings: list[str] = []

    # (1) Reboot under load, seen over the WebSocket — the strongest signal and
    # independent of any serial parsing.
    if ws_dropped:
        failures.append(
            "player WebSocket dropped during the soak — the DUT rebooted or faulted "
            "under FULL-perf load"
        )

    fx = parse_fx_lines(serial)
    faults = find_fault_markers(serial)
    boots = (serial or "").count(BOOT_BANNER)

    # (2) Serial-based fault / reboot / render-outcome checks.
    if serial_captured:
        if faults:
            failures.append("serial shows fault/watchdog marker(s): " + ", ".join(faults))
        if boots > expected_boots:
            failures.append(
                f"DUT rebooted during the soak: {boots} app-boot banner(s) "
                f"({BOOT_BANNER!r}) in serial, expected <= {expected_boots}"
            )
        bad_updates = [f for f in fx if f["update"] != "ok"]
        if bad_updates:
            kinds = ", ".join(sorted({f["update"] for f in bad_updates}))
            failures.append(
                f"{len(bad_updates)}/{len(fx)} render frame(s) not update=ok (saw {kinds}) — "
                "the FX VM tripped its bounded-exec budget / wall-time deadline"
            )
        cancelled = [f for f in fx if f["cancelled"] > 0]
        if cancelled:
            worst = max(f["cancelled"] for f in cancelled)
            failures.append(
                f"{len(cancelled)} frame(s) with shade_cancelled>0 (worst {worst}) — "
                "per-LED shades blew the bounded-exec guard"
            )
        if len(fx) < min_fx_lines:
            failures.append(
                f"only {len(fx)} `[fx]` render line(s) in serial (expected >= {min_fx_lines}); "
                "the effect may not have rendered under load for the whole window"
            )

    # (3) heap_min_free stability from the streamed PerfReports.
    heap = heap_min_free_series(perf_samples)
    heap_end = heap[-1] if heap else 0
    heap_min = min(heap) if heap else 0
    back_drift = 0
    if len(heap) < min_heap_samples:
        warnings.append(
            f"only {len(heap)} populated heap_min_free sample(s) (wanted >= {min_heap_samples}); "
            "heap stability under-observed"
        )
    else:
        if heap_floor_bytes > 0 and heap_min < heap_floor_bytes:
            failures.append(
                f"heap_min_free dipped to {heap_min} B, below the {heap_floor_bytes} B floor"
            )
        # min_free is a since-boot low-water mark (monotone non-increasing), so a
        # HEALTHY run flattens: the back half stops dropping. A still-falling back
        # half is an ongoing leak under load.
        back = heap[len(heap) // 2 :]
        back_drift = back[0] - back[-1]
        if back_drift > heap_drift_bytes:
            failures.append(
                f"heap_min_free still falling at end of soak: dropped {back_drift} B across the "
                f"back half (> {heap_drift_bytes} B) — a leak under load, not a settled floor"
            )

    drops = _dropped_totals(perf_samples)
    if drops["overruns"] or drops["droppedFrames"]:
        warnings.append(
            f"perf ring saw {drops['droppedFrames']} dropped frame(s), {drops['overruns']} "
            f"overrun(s), {drops['samplesDropped']} sample(s) dropped over the soak"
        )

    stats = {
        "wsDropped": ws_dropped,
        "serialCaptured": serial_captured,
        "bootBanners": boots,
        "faultMarkers": faults,
        "fxLines": len(fx),
        "fxNotOk": len([f for f in fx if f["update"] != "ok"]),
        "fxCancelledFrames": len([f for f in fx if f["cancelled"] > 0]),
        "heapSamples": len(heap),
        "heapMinFreeEnd": heap_end,
        "heapMinFreeLow": heap_min,
        "heapBackHalfDriftBytes": back_drift,
        "drops": drops,
    }
    return {"ok": not failures, "failures": failures, "warnings": warnings, "stats": stats}


def format_report(verdict: dict[str, Any]) -> str:
    """A human-readable multi-line summary of an evaluate_soak result."""
    st = verdict["stats"]
    lines = [
        "JIT-on soak verdict: " + ("PASS" if verdict["ok"] else "FAIL"),
        f"  ws_dropped={st['wsDropped']} boots={st['bootBanners']} "
        f"faults={st['faultMarkers'] or 'none'}",
        f"  fx_lines={st['fxLines']} not_ok={st['fxNotOk']} "
        f"cancelled_frames={st['fxCancelledFrames']}",
        f"  heap_min_free: samples={st['heapSamples']} end={st['heapMinFreeEnd']}B "
        f"low={st['heapMinFreeLow']}B back_half_drift={st['heapBackHalfDriftBytes']}B",
        f"  drops={st['drops']}",
    ]
    for w in verdict["warnings"]:
        lines.append(f"  WARN: {w}")
    for f in verdict["failures"]:
        lines.append(f"  FAIL: {f}")
    return "\n".join(lines)
