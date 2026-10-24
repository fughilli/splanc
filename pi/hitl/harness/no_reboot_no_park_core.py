"""Pure logic for the "a slow effect lags, the board never reboots for WiFi" HITL gate
(hitl_no_reboot_no_park.py): parse the DUT serial for the facts that matter, and grade.

Field report (PixieLamp, netstack C6, 250 LEDs): the fixture looked nothing like the
workspace preview because

  * its effect ran at ~9 fps, so after ~6 s the framerate autoscaler PARKED it
    ("[fps] effect parked: can't hold 25 fps with 5% headroom"), and
  * the stored network wasn't in the boot scan, so every 20 s the board logged
    "restarting to rescan (attempt N/12)" and esp_restart()ed — the effect restarted
    from t=0 and got parked again, forever.

The fixed firmware never parks a slow effect (it lags, running as fast as it can with
the render duty cycle bounded) and never reboots for WiFi (it rescans in the
background while the effect keeps rendering). The gate checks both on real hardware:

  slow phase   a deliberately slow effect keeps advancing frames for --slow-seconds,
               is never parked, shades its LEDs (non-black colour), and the device
               answers control commands within a latency budget the whole time;
  nonet phase  credentials for an SSID that doesn't exist: for --nonet-seconds the
               device does NOT reset (no boot banner, the effect's frame counter and
               time keep climbing), the effect keeps running, background scans run —
               and then valid credentials join again.

Asserting-gate convention: an infra problem (never provisioned, wss never came up,
no serial captured) is SKIP; FAIL only when the device demonstrably misbehaved.
"""

from __future__ import annotations

import re
import statistics

# "[fx] t=43.89 frame=1249 update=ok shade_cancelled=0/48" (1 Hz while an effect renders).
FX_RE = re.compile(
    r"\[fx\] t=(-?\d+(?:\.\d+)?) frame=(\d+) update=(\w+) shade_cancelled=(\d+)/(\d+)"
)
# Any of these means the chip restarted inside the window.
RESET_RES = (
    re.compile(r"ESP-ROM:esp32"),
    re.compile(r"rst:0x[0-9a-f]+ \("),
    re.compile(r"\[boot\] reset_reason="),
    re.compile(r"^Rebooting\.\.\.", re.M),
)
PARKED = "effect parked"
RESTART_TO_RESCAN = "restarting to rescan"
BG_SCAN_RE = re.compile(r"\[wifi\] .*background scan")
LAG_RE = re.compile(r"\[fps\] effect lagging: running at (\d+) fps")

# Defaults (overridable from the driver).
MIN_FRAME_RATE = 1.0  # frames/s the slow effect must still average (it runs ~5-15 fps)
CONTROL_P50_S = 3.0  # median control round trip under the slow effect (tunnel included)
CONTROL_MAX_S = 15.0  # no single control round trip may take longer
# Background-scan log lines (a start + a result per sweep) in a ~100 s outage: sweeps
# at ~5, 15, 37 and 78 s on the 5 s -> 60 s backoff, so >= 2 sweeps = 4 lines.
MIN_SCAN_LINES = 4


def fx_samples(log: str) -> list[tuple[float, int, str, int, int]]:
    """Every [fx] line: (effect time s, frame, update outcome, shade_cancelled, leds)."""
    out = []
    for m in FX_RE.finditer(log or ""):
        out.append(
            (float(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4)), int(m.group(5)))
        )
    return out


def resets(log: str) -> list[str]:
    """The reset markers found in `log` (empty = the chip never restarted)."""
    found = []
    for r in RESET_RES:
        m = r.search(log or "")
        if m:
            found.append(m.group(0).strip())
    return found


def frames_advance(samples: list[tuple[float, int, str, int, int]]) -> tuple[bool, str]:
    """Whether the effect kept rendering through the window: frame numbers strictly
    increase (a reset or a re-activation would restart them), effect time never jumps
    back, and every LED was shaded (none cancelled -> real colour, not held/black)."""
    if len(samples) < 2:
        return False, f"only {len(samples)} [fx] sample(s)"
    for (t0, f0, _, _, _), (t1, f1, _, _, _) in zip(samples, samples[1:]):
        if f1 <= f0:
            return False, f"frame counter went {f0} -> {f1} (effect restarted)"
        if t1 < t0:
            return False, f"effect time went {t0} -> {t1} (effect restarted)"
    if any(n == 0 for (_, _, _, _, n) in samples):
        return False, "an [fx] sample shaded 0 LEDs (no map?)"
    worst = max(c for (_, _, _, c, _) in samples)
    if worst > 0:
        return False, f"the bounded-exec guard cancelled up to {worst} shades in a frame"
    return True, ""


def grade_slow(
    log: str,
    seconds: float,
    rtts: list[float | None],
    min_frame_rate: float = MIN_FRAME_RATE,
    p50_s: float = CONTROL_P50_S,
    max_s: float = CONTROL_MAX_S,
    fps_state: dict | None = None,
) -> dict:
    """Grade the slow-effect window: `log` is its serial, `rtts` the control round
    trips (None = no reply), `fps_state` the player's last report (camelCase). An
    effect measured well below the floor must be reported lagging, with the rate it
    achieves — that is the advisory that replaced parking."""
    problems: list[str] = []
    s = fx_samples(log)
    ok, why = frames_advance(s)
    if not ok:
        problems.append(f"slow effect: {why}")
    span = (s[-1][0] - s[0][0]) if len(s) >= 2 else 0.0
    frames = (s[-1][1] - s[0][1]) if len(s) >= 2 else 0
    rate = frames / span if span > 0 else 0.0
    if span < 0.8 * seconds:
        problems.append(
            f"slow effect: [fx] lines span only {span:.0f} s of the {seconds:.0f} s window"
        )
    if rate < min_frame_rate:
        problems.append(f"slow effect: {rate:.1f} frames/s < {min_frame_rate}")
    if PARKED in (log or ""):
        problems.append("slow effect was PARKED")
    r = resets(log)
    if r:
        problems.append(f"device reset during the slow phase: {r}")
    answered = [x for x in rtts if x is not None]
    missed = len(rtts) - len(answered)
    if not rtts:
        problems.append("no control round trips were measured")
    elif missed:
        problems.append(f"{missed}/{len(rtts)} control commands got no reply")
    p50 = statistics.median(answered) if answered else None
    worst = max(answered) if answered else None
    if p50 is not None and p50 > p50_s:
        problems.append(f"control median {p50:.2f} s > {p50_s} s")
    if worst is not None and worst > max_s:
        problems.append(f"control max {worst:.2f} s > {max_s} s")
    lag = LAG_RE.search(log or "")
    st = fps_state or {}
    floor = float(st.get("minFps") or 25)
    if fps_state is not None and 0 < rate < 0.8 * floor:
        if not st.get("lagging"):
            problems.append(
                f"effect runs at {rate:.1f} fps < {floor:g} but fps_state isn't lagging"
            )
        elif not st.get("achievedFps"):
            problems.append("fps_state is lagging but reports no achieved_fps")
    if st.get("aborted"):
        problems.append("fps_state reports aborted (parked)")
    return {
        "fx_samples": len(s),
        "span_s": round(span, 1),
        "frames": frames,
        "fps": round(rate, 2),
        "lag_line_fps": int(lag.group(1)) if lag else None,
        "control_n": len(rtts),
        "control_p50_s": round(p50, 3) if p50 is not None else None,
        "control_max_s": round(worst, 3) if worst is not None else None,
        "problems": problems,
    }


def grade_nonet(log: str, seconds: float) -> dict:
    """Grade the missing-network window (its serial, captured continuously)."""
    problems: list[str] = []
    r = resets(log)
    if r:
        problems.append(f"device RESET while the network was missing: {r}")
    if RESTART_TO_RESCAN in (log or ""):
        problems.append("firmware still restarts to rescan")
    s = fx_samples(log)
    ok, why = frames_advance(s)
    if not ok:
        problems.append(f"effect during the outage: {why}")
    span = (s[-1][0] - s[0][0]) if len(s) >= 2 else 0.0
    if span < 0.8 * seconds:
        problems.append(f"effect: [fx] lines span only {span:.0f} s of the {seconds:.0f} s outage")
    if PARKED in (log or ""):
        problems.append("effect was PARKED during the outage")
    scans = len(BG_SCAN_RE.findall(log or ""))
    if scans < MIN_SCAN_LINES:
        problems.append(f"only {scans} background-scan log line(s) (expected the rescan to run)")
    return {
        "fx_samples": len(s),
        "span_s": round(span, 1),
        "frames": (s[-1][1] - s[0][1]) if len(s) >= 2 else 0,
        "bg_scan_lines": scans,
        "resets": r,
        "problems": problems,
    }


def verdict(
    provisioned: bool, slow: dict | None, nonet: dict | None, rejoined: bool | None
) -> dict:
    """Overall verdict. SKIP when the DUT never got onto the network or the phases
    couldn't run (infra); FAIL on any graded problem or a failed rejoin."""
    if not provisioned:
        return {"verdict": "SKIP", "skip": "the DUT never leased on the rig AP", "problems": []}
    if slow is None:
        return {
            "verdict": "SKIP",
            "skip": "the slow-effect phase didn't run (wss/upload)",
            "problems": [],
        }
    problems = list(slow["problems"])
    if nonet is not None:
        problems += nonet["problems"]
        if rejoined is False:
            problems.append("valid credentials after the outage did not lease again")
    return {"verdict": "FAIL" if problems else "PASS", "skip": None, "problems": problems}


def result_line(unit: str, g: dict, slow: dict | None, nonet: dict | None) -> str:
    """The grep-able summary line."""
    s = slow or {}
    n = nonet or {}
    line = (
        f"RESULT unit={unit} slow_fps={s.get('fps')} control_p50={s.get('control_p50_s')} "
        f"control_max={s.get('control_max_s')} nonet_frames={n.get('frames')} "
        f"bg_scans={n.get('bg_scan_lines')} verdict={g['verdict']}"
    )
    if g.get("skip"):
        line += f" skip={g['skip']!r}"
    return line
