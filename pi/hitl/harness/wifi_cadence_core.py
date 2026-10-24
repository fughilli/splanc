"""Pure logic for the Wi-Fi rejoin cadence measurement / gate (hitl_wifi_cadence.py):
does scanning, joining or failing to join disturb the LED output?

Two independent views of every phase:

  wire    the rig's logic analyzer decodes the WS2812 line: one record per frame
          (start_us, flags such as runt / gap / split). Frame-to-frame start intervals
          are the cadence a viewer actually sees.
  device  the firmware's 1 Hz "[ft] r<n>:<min>/<mean>/<max> w<n>:<min>/<mean>/<max>
          dt<ms>" fields: render-start and wire-out-start interval stats per window and
          the largest effect time step, so a render stall or a time-base jump is visible
          even where there is no analyzer.

The baseline is the steady phase of the same effect (no Wi-Fi activity): an excursion
is a frame interval that deviates from the steady median by more than the steady
phase's own spread allows.

Asserting-gate convention: infra (no analyzer data, no [ft] lines, a phase that could
not be driven) is SKIP; FAIL only on a measured excursion.
"""

from __future__ import annotations

import re
import statistics

FT_RE = re.compile(
    r"\[ft\] r(?P<rn>\d+):(?P<rmin>\d+)/(?P<rmean>\d+)/(?P<rmax>\d+) "
    r"w(?P<wn>\d+):(?P<wmin>\d+)/(?P<wmean>\d+)/(?P<wmax>\d+) dt(?P<dt>\d+)"
)

# An excursion must exceed BOTH: an absolute floor (one 1 ms RTOS tick of jitter is
# invisible) and a multiple of the steady phase's own p99.9 deviation (a lagging heavy
# effect's frame cost varies by itself).
ABS_FLOOR_US = 3000.0
REL_FLOOR = 0.02  # ... and 2 % of the frame period (a 183 ms frame's cost itself varies)
REL_MARGIN = 1.5
# The analyzer decodes glitch bits after every frame for up to ~1.7 s from the START of a
# capture, intermittently, in every phase including steady (no Wi-Fi activity) and never
# later in a capture — an artifact of the capture starting, not of the DUT. Damage in this
# window is reported but not graded; the harness issues each phase's command after it.
WARMUP_US = 2_000_000.0
# The analyzer flags that mean a frame went out damaged (not merely late). The broker's
# "short_gap_before" alone is not damage: it fires below ~1 ms, while a WS2812B-V5 only
# needs a >= 280 µs low to latch — that case is judged on gap_before_us (LATCH_US).
BAD_FLAGS = ("runt", "intra_gap", "split", "oversize", "bad_bit", "partial_bits")
LATCH_US = 280.0


def percentile(xs: list[float], q: float) -> float:
    """Nearest-rank percentile (q in 0..100) of a non-empty list."""
    s = sorted(xs)
    k = max(0, min(len(s) - 1, int(round(q / 100.0 * len(s) + 0.5)) - 1))
    return s[k]


def wire_periods(frames: list[dict], warmup_us: float = None) -> list[float]:
    """Start-to-start intervals (µs) of consecutive whole analyzer frames, from the end
    of the capture warm-up (WARMUP_US) on."""
    w = WARMUP_US if warmup_us is None else warmup_us
    starts = [
        float(f["start_us"])
        for f in whole_frames(frames)
        if f.get("start_us") is not None and float(f["start_us"]) >= w
    ]
    return [b - a for a, b in zip(starts, starts[1:])]


def damaged(frames: list[dict], warmup_us: float = 0.0) -> list[dict]:
    """Analyzer frames flagged as damaged on the wire. The first and last frame of a
    capture are cut by the capture window itself ("truncated"), not by the DUT; frames
    starting within `warmup_us` of the capture start are skipped (WARMUP_US)."""
    out = []
    for i, f in enumerate(frames):
        if float(f.get("start_us") or 0.0) < warmup_us:
            continue
        flags = f.get("flags") or []
        if (i == 0 or i == len(frames) - 1) and "truncated" in flags:
            continue
        gap = f.get("gap_before_us")
        if any(fl in BAD_FLAGS for fl in flags) or (gap is not None and i > 0 and gap < LATCH_US):
            out.append(f)
    return out


def whole_frames(frames: list[dict]) -> list[dict]:
    """Frames for cadence: drop the capture-window-truncated first / last frame."""
    out = list(frames)
    if out and "truncated" in (out[0].get("flags") or []):
        out = out[1:]
    if out and "truncated" in (out[-1].get("flags") or []):
        out = out[:-1]
    return out


def ft_samples(log: str) -> list[dict]:
    """Every [ft] cadence line's fields (µs, dt in ms)."""
    out = []
    for m in FT_RE.finditer(log or ""):
        d = {k: int(v) for k, v in m.groupdict().items()}
        out.append(d)
    return out


def device_view(log: str) -> dict:
    """Worst render / wire interval and effect time step the device saw in a phase."""
    s = [x for x in ft_samples(log) if x["rn"] > 0]
    if not s:
        return {"windows": 0}
    return {
        "windows": len(s),
        "render_max_us": max(x["rmax"] for x in s),
        "render_mean_us": round(statistics.mean(x["rmean"] for x in s)),
        "wire_max_us": max(x["wmax"] for x in s),
        "wire_mean_us": round(
            statistics.mean(x["wmean"] for x in s if x["wn"] > 0) if any(x["wn"] for x in s) else 0
        ),
        "dt_max_ms": max(x["dt"] for x in s),
    }


def baseline(steady_periods: list[float]) -> dict:
    """Median period and deviation spread of the steady phase."""
    med = statistics.median(steady_periods)
    dev = [abs(p - med) for p in steady_periods]
    return {
        "median_us": med,
        "dev_max_us": max(dev),
        "dev_p999_us": percentile(dev, 99.9),
        "threshold_us": max(ABS_FLOOR_US, REL_FLOOR * med, REL_MARGIN * percentile(dev, 99.9)),
    }


def phase_wire(
    periods: list[float], frames: list[dict], base: dict, warmup_us: float = WARMUP_US
) -> dict:
    """A phase's wire cadence against the steady baseline (damage graded after the
    capture warm-up; the warm-up's own count is reported separately)."""
    if not periods:
        return {"frames": 0}
    dev = [abs(p - base["median_us"]) for p in periods]
    over = [p for p, d in zip(periods, dev) if d > base["threshold_us"]]
    return {
        "frames": len(periods) + 1,
        "median_us": statistics.median(periods),
        "dev_max_us": round(max(dev)),
        "dev_p999_us": round(percentile(dev, 99.9)),
        "max_period_us": round(max(periods)),
        "excursions": len(over),
        "worst_excursion_us": round(max(over)) if over else 0,
        "damaged": len(damaged(frames, warmup_us)),
        "damaged_at_s": [round(f["start_us"] / 1e6, 2) for f in damaged(frames, warmup_us)][:10],
        "damaged_warmup": len(damaged(frames)) - len(damaged(frames, warmup_us)),
    }


def phase_device(dev: dict, steady_dev: dict) -> dict:
    """The device view of a phase, with its excursion against the steady phase."""
    if not dev.get("windows") or not steady_dev.get("windows"):
        return {**dev, "render_excess_us": None, "wire_excess_us": None}
    return {
        **dev,
        "render_excess_us": dev["render_max_us"] - steady_dev["render_max_us"],
        "wire_excess_us": dev["wire_max_us"] - steady_dev["wire_max_us"],
    }


def grade(
    results: dict, gated_phases: tuple[str, ...], device_threshold_us: float = 4000.0
) -> dict:
    """Verdict over every effect's phases. `results[effect][phase]` = {"wire": ..., "device":
    ...}. Wire excursions / damaged frames FAIL a gated phase; with no analyzer data the
    device view decides (render or wire-out interval max beyond the steady phase's by more
    than `device_threshold_us`, or an effect time step above 1 s)."""
    problems: list[str] = []
    measured = 0
    for eff, phases in results.items():
        for ph in gated_phases:
            r = phases.get(ph)
            if not r:
                continue
            w, d = r.get("wire") or {}, r.get("device") or {}
            if w.get("frames"):
                measured += 1
                if w.get("excursions"):
                    problems.append(
                        f"{eff}/{ph}: {w['excursions']} wire frame interval(s) off cadence "
                        f"(worst {w['worst_excursion_us'] / 1000:.1f} ms vs median "
                        f"{w['median_us'] / 1000:.1f} ms)"
                    )
                if w.get("damaged"):
                    problems.append(f"{eff}/{ph}: {w['damaged']} damaged frame(s) on the wire")
            elif d.get("windows"):
                measured += 1
                for k in ("render_excess_us", "wire_excess_us"):
                    if d.get(k) is not None and d[k] > device_threshold_us:
                        problems.append(f"{eff}/{ph}: device {k} {d[k] / 1000:.1f} ms")
            if d.get("dt_max_ms", 0) > 1000:
                problems.append(
                    f"{eff}/{ph}: effect time stepped {d['dt_max_ms']} ms (time-base jump)"
                )
    if measured == 0:
        return {
            "verdict": "SKIP",
            "skip": "no phase produced wire or device timing",
            "problems": [],
        }
    return {"verdict": "FAIL" if problems else "PASS", "skip": None, "problems": problems}


# -- Rejoin-policy checks (the "policy" step) --------------------------------------
OFFLINE_SILENT = "offline mode: Wi-Fi silent now"
OFFLINE_BOOT = "offline mode: radio off"
VENDOR_SCAN = "[scan] err="
LEASE = "DHCP LEASE ACQUIRED"


def grade_policy(to_offline: str, offline_boot: str, back_to_auto: str) -> list[str]:
    """Problems with the offline-mode round trip: going offline at runtime goes silent
    without stopping the effect, an offline boot never starts the radio (no vendor scan)
    yet plays the show, and switching back to auto leases again without a reboot."""
    problems: list[str] = []
    if OFFLINE_SILENT not in to_offline:
        problems.append("policy: WIFI MODE offline did not go silent")
    if not ft_samples(to_offline):
        problems.append("policy: the effect stopped rendering when going offline")
    if OFFLINE_BOOT not in offline_boot:
        problems.append("policy: an offline-mode boot did not keep the radio off")
    if VENDOR_SCAN in offline_boot:
        problems.append("policy: an offline-mode boot ran the vendor scan (radio started)")
    if not ft_samples(offline_boot):
        problems.append("policy: no effect frames after the offline-mode boot")
    if LEASE not in back_to_auto:
        problems.append("policy: WIFI MODE auto after offline did not lease again")
    for name, log in (("to_offline", to_offline), ("back_to_auto", back_to_auto)):
        if resets_in(log):
            problems.append(f"policy: the board reset during {name}")
    return problems


def resets_in(log: str) -> bool:
    return "ESP-ROM:esp32" in (log or "") or "[boot] reset_reason=" in (log or "")
