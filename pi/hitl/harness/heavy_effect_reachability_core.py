"""Pure pass/fail policy for the heavy-effect reachability HITL gate.

Field regression (firmware 1.12.3, two C6 players): once an effect that nearly filled
its frame budget was active, NEW clients could no longer connect (no TLS/WebSocket
handshake within 8 s, the HTTPS manifest GET timed out) while mDNS still answered and
the LEDs kept animating; a power cycle did not help because the persisted effect
restarted at boot. Since #371 the netstack loop ran one priority below render whenever
no wss session was up, and a frame that fit its period slept only the few ms left of
it, so the loop (and with it TCP, the TLS handshake, DHCP and the Wi-Fi join) got a
few percent of the CPU.

hitl_heavy_effect_reachability.py drives the board into exactly that state and this
module grades it. Phases (one reservation):

  idle    the heavy effect plays, every session closed for IDLE_WAIT_S; then NEW
          connections (TLS + WebSocket + hello/welcome) must each complete within
          HANDSHAKE_S, STREAK of them in a row;
  rejoin  a forced Wi-Fi rejoin under the heavy effect (PROV a missing network, then
          the rig AP again: sweep + PBKDF2 + join + DHCP) must re-lease and accept a
          connection within REJOIN_DEADLINE_S;
  boot    reset with the heavy effect persisted: a connection must succeed within
          BOOT_DEADLINE_S of the reset (the persisted effect starts before Wi-Fi).

Every phase gates on its persistent END state (a run of good connections), never on
one slow attempt (hitl-gate-test-authoring). Infra — no baseline connection, the
calibration never ran, the rig itself unreachable — is SKIP, not FAIL.
"""

from __future__ import annotations

import re

# The agent bridge's connect deadline ("no TLS/WebSocket handshake within 8 s").
HANDSHAKE_S = 8.0
# Consecutive good connections that prove the idle phase recovered.
STREAK = 5
# After a phase's first good connection, this many more in a row (boot / rejoin).
FOLLOW_STREAK = 3
# Attempts the idle phase may spend finding its streak.
MAX_ATTEMPTS = 10
# How long every session stays closed before the idle phase dials in.
IDLE_WAIT_S = 30.0
# Before that, one silent session is held this long (past the firmware's 15 s quiet-
# session ping) and must still answer: the ghost-session reclaim never kills a live one.
HOLD_IDLE_S = 35.0
# Reset -> first good connection, heavy effect persisted. rejoin_loop's p95 boot ->
# lease is ~8.5 s on an idle board; the join itself runs below render priority, so
# allow it a heavy effect's lag on top.
BOOT_DEADLINE_S = 60.0
# The rig-AP PROV -> first good connection (PBKDF2 + join + DHCP + TLS).
REJOIN_DEADLINE_S = 60.0

# Calibration: map size so one frame costs CAL_DUTY of the floor rung's period. Just
# under the autoscaler's 95 % headroom the floor holds (no step down) and a frame
# sleeps only what is left of its period: the starving case. An over-period frame
# instead got the 20 % overrun slice (why a far heavier effect stayed reachable).
FLOOR_FPS = 25
CAL_DUTY = 0.93
CAL_MIN_LEDS = 32
CAL_MAX_LEDS = 512  # the 25 fps floor holds up to 512 LEDs (fps floor_fps_for)
# A sized frame outside this band of the floor period gets one more sizing pass (the
# probe's fixed per-frame overhead makes the first linear estimate land low).
CAL_BAND = (0.91, 0.95)

OK = "ok"
SLOW = "slow"  # completed, but past HANDSHAKE_S
TIMEOUT = "timeout"
REJECTED = "rejected"
ERROR = "error"


def classify(exc: BaseException | None, seconds: float) -> str:
    """One connection attempt, from the exception it raised (None = it completed)."""
    if exc is None:
        return OK if seconds <= HANDSHAKE_S else SLOW
    if isinstance(exc, TimeoutError):
        return TIMEOUT
    if isinstance(exc, (ConnectionError, BrokenPipeError, EOFError, OSError)):
        return REJECTED
    name = type(exc).__name__
    if "SSL" in name or "TLS" in name or "ConnectionClosed" in name or "InvalidMessage" in name:
        return REJECTED
    return ERROR


def leds_for_budget(
    frame_cycles: float,
    leds: int,
    cpu_hz: int = 160_000_000,
    fps: int = FLOOR_FPS,
    duty: float = CAL_DUTY,
    fixed_cycles: float = 0.0,
) -> int:
    """LEDs that make one frame cost `duty` of 1/fps, from a measured frame of `leds`
    LEDs costing `frame_cycles` (linear per LED above `fixed_cycles`), clamped to
    [CAL_MIN_LEDS, CAL_MAX_LEDS]."""
    per_led = max(1.0, (frame_cycles - fixed_cycles) / max(1, leds))
    target = cpu_hz / fps * duty - fixed_cycles
    n = int(target / per_led)
    return max(CAL_MIN_LEDS, min(CAL_MAX_LEDS, n))


def frame_duty(frame_cycles: float, cpu_hz: int = 160_000_000, fps: int = FLOOR_FPS) -> float:
    """A frame's cost as a fraction of the floor rung's period."""
    return frame_cycles / (cpu_hz / fps)


def longest_ok_run(cats: list[str]) -> int:
    best = run = 0
    for c in cats:
        run = run + 1 if c == OK else 0
        best = max(best, run)
    return best


def first_ok(attempts: list[dict]) -> dict | None:
    for a in attempts:
        if a["cat"] == OK:
            return a
    return None


def grade_idle(attempts: list[dict], rig_ok: bool = True, held: bool = True) -> dict:
    """attempts: [{"cat", "s", "t"}] in order. PASS once STREAK in a row completed
    within HANDSHAKE_S, and the silent session held before them (`held`) survived."""
    cats = [a["cat"] for a in attempts]
    run = longest_ok_run(cats)
    out = {
        "attempts": len(cats),
        "ok": cats.count(OK),
        "streak": run,
        "times_s": [round(a["s"], 2) for a in attempts],
        "cats": cats,
    }
    if run >= STREAK and not held:
        out["verdict"] = "FAIL"
        out["why"] = f"a silent live session was dropped (held {HOLD_IDLE_S:g}s)"
    elif run >= STREAK:
        out["verdict"] = "PASS"
    elif not attempts or not rig_ok:
        out["verdict"] = "SKIP"
        out["why"] = "no attempts" if not attempts else "rig unreachable"
    else:
        out["verdict"] = "FAIL"
        out["why"] = f"new connections: longest run {run}/{STREAK} within {HANDSHAKE_S:g}s"
    return out


def grade_reconnect(
    attempts: list[dict], deadline_s: float, booted: bool = True, rig_ok: bool = True
) -> dict:
    """Boot / rejoin: the first good connection (t = seconds since the phase's
    trigger) within `deadline_s`, then FOLLOW_STREAK more in a row."""
    f = first_ok(attempts)
    out: dict = {
        "attempts": len(attempts),
        "first_ok_s": round(f["t"], 1) if f else None,
        "cats": [a["cat"] for a in attempts],
    }
    if f is not None:
        after = [a["cat"] for a in attempts[attempts.index(f) + 1 :]]
        out["follow"] = longest_ok_run(after)
    if not booted or not rig_ok or not attempts:
        out["verdict"] = "SKIP"
        out["why"] = (
            "board never booted"
            if not booted
            else ("rig unreachable" if not rig_ok else "no attempts")
        )
    elif f is None or f["t"] > deadline_s:
        out["verdict"] = "FAIL"
        out["why"] = (
            f"no connection within {deadline_s:g}s"
            if f is None
            else f"first connection after {f['t']:.1f}s (> {deadline_s:g}s)"
        )
    elif out["follow"] < min(FOLLOW_STREAK, len(attempts) - attempts.index(f) - 1):
        out["verdict"] = "FAIL"
        out["why"] = f"connected at {f['t']:.1f}s but then only {out['follow']} in a row"
    else:
        out["verdict"] = "PASS"
    return out


_LOOP_GAP_RE = re.compile(r"\[net\] t=\d+ .*?loop_gap_max=(\d+)us")
_FT_RE = re.compile(r"\[ft\] r(\d+):\d+/(\d+)/(\d+) .*?fps=(\d+) sl=(\d+)-(\d+)")
_LEASE_RE = re.compile(r"DHCP LEASE ACQUIRED")


def loop_gaps_ms(log: str) -> list[float]:
    """The firmware's 5 s `[net] ... loop_gap_max=` values (ms): the longest stretch
    the netstack loop went without running."""
    return [int(m.group(1)) / 1000.0 for m in _LOOP_GAP_RE.finditer(log)]


def render_fps(log: str) -> list[int]:
    """The 1 Hz `[ft]` line's fps values (the effect kept rendering)."""
    return [int(m.group(4)) for m in _FT_RE.finditer(log)]


def render_sleep_ms(log: str) -> list[int]:
    """The `[ft]` line's shortest render sleep per window (ms): what render left the
    lower-priority tasks between two frames."""
    return [int(m.group(5)) for m in _FT_RE.finditer(log)]


def booted(log: str) -> bool:
    """The reset capture shows the board coming up (ROM banner / reset reason)."""
    return any(m in log for m in ("ESP-ROM", "rst:0x", "SPI_FAST_FLASH_BOOT"))


def leased(log: str) -> bool:
    return bool(_LEASE_RE.search(log))


def summarize_console(log: str) -> dict:
    gaps = loop_gaps_ms(log)
    fps = render_fps(log)
    sl = render_sleep_ms(log)
    return {
        "sleep_min_p50_ms": sorted(sl)[len(sl) // 2] if sl else None,
        "loop_gap_max_ms": max(gaps) if gaps else None,
        "loop_gap_p50_ms": sorted(gaps)[len(gaps) // 2] if gaps else None,
        "fps_p50": sorted(fps)[len(fps) // 2] if fps else None,
        "lines": len(log.splitlines()),
    }


def verdict(baseline_ok: bool, calibrated: bool, phases: dict[str, dict]) -> dict:
    """Overall: SKIP without a baseline connection or calibration; FAIL if any phase
    FAILed; PASS if at least one phase PASSed and none failed; SKIP otherwise."""
    if not baseline_ok:
        return {"verdict": "SKIP", "skip": "no baseline connection (infra)", "problems": []}
    if not calibrated:
        return {"verdict": "SKIP", "skip": "heavy effect never calibrated (infra)", "problems": []}
    problems = [f"{k}: {v.get('why', '')}" for k, v in phases.items() if v["verdict"] == "FAIL"]
    if problems:
        return {"verdict": "FAIL", "skip": None, "problems": problems}
    if any(v["verdict"] == "PASS" for v in phases.values()):
        return {"verdict": "PASS", "skip": None, "problems": []}
    return {"verdict": "SKIP", "skip": "no phase could be graded", "problems": []}


# The console windows each phase captures (hitl_heavy_effect_reachability.py saves
# every one to its --log-dir, the test's undeclared outputs).
PHASE_WINDOWS = {"idle": ("idle",), "rejoin": ("rejoin_drop", "rejoin"), "boot": ("boot",)}
# Slack on a window's planned activity: the reader's ssh start, the last dial's tail.
WINDOW_SLACK_S = 30.0
# A passing phase's window prints only this tail on a FAIL (the failing ones print whole).
PASS_WINDOW_TAIL = 5000


def idle_window_s(hold_s: float, wait_s: float, gap_s: float, open_timeout_s: float) -> float:
    """How long the idle phase's console window stays open. It must cover the held
    silent session (open + hello, the hold, the closing RPC), the closed wait and up
    to MAX_ATTEMPTS dials (each up to HANDSHAKE_S + 0.5 s, gap_s apart), so the moment
    a held session drops or a dial stalls is always inside it. The harness ends the
    window early once the phase is done."""
    hold = open_timeout_s + hold_s + 15.0 if hold_s > 0 else 0.0
    return hold + wait_s + MAX_ATTEMPTS * (HANDSHAKE_S + 0.5 + gap_s) + WINDOW_SLACK_S


def windows_to_print(phases: dict[str, dict], windows: list[str]) -> list[tuple[str, bool]]:
    """(window, whole) for each captured console window, in capture order, to print on
    a FAIL: the whole window for every phase that FAILed, the last PASS_WINDOW_TAIL
    characters for the others."""
    failing = {
        w
        for name, p in phases.items()
        if p.get("verdict") == "FAIL"
        for w in PHASE_WINDOWS.get(name, ())
    }
    return [(w, w in failing) for w in windows]


def result_line(unit: str, cal: dict, phases: dict[str, dict], g: dict) -> str:
    parts = [f"RESULT unit={unit}"]
    if cal:
        parts.append(f"leds={cal.get('leds')} duty={cal.get('duty')}")
    for name in ("idle", "rejoin", "boot"):
        p = phases.get(name)
        if not p:
            continue
        if name == "idle":
            parts.append(
                f"idle={p['verdict']}({p['streak']}/{STREAK},ok={p['ok']}/{p['attempts']})"
            )
        else:
            parts.append(f"{name}={p['verdict']}(first_ok_s={p.get('first_ok_s')})")
    parts.append(f"verdict={g['verdict']}")
    if g.get("skip"):
        parts.append(f"skip={g['skip']!r}")
    return " ".join(parts)
