"""Pure analysis for the long-run video latency/jitter/burst HITL test (video_latency).

The rig-side probe (wss_video_latency.py) streams paced SetTexture frames over the
device's wss for minutes and prints raw rows; this module turns them into the numbers
that matter for "no lagginess":

  * send->applied LATENCY per frame: every frame is followed by a TimeSyncPing whose
    device timestamp is taken right after the frame was applied (the player handles
    messages in order on one task), mapped onto the host clock with an NTP-style
    min-RTT offset fit from idle ping bursts before and after the stream (so the
    device crystal's drift over minutes cancels);
  * inter-frame JITTER of the device-side apply instants (a paced 30 fps sender
    should land every ~33 ms);
  * BURSTS: a stall (gap > stall_ms between two applied frames) followed by a
    catch-up (several queued frames applied back to back) -- the "laggy burst" the
    eye sees -- each one attributed from the sender's TCP_INFO around it: TCP
    retransmission (loss -> RTO/recovery), receive-window-limited (the device not
    draining its 4 KB window), or neither (the device was busy / not reading).

No I/O: parsed + judged here so //pi/hitl/tests can unit-test it with no rig.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple


@dataclass
class Frame:
    seq: int
    t_sched: float
    t_enq: float
    app_q: int
    kern_q: int
    nbytes: int
    skipped_before: int
    t1_dev: Optional[float] = None  # device ms at apply (from the trailing ping)
    t3: Optional[float] = None  # host ms the ping's pong arrived


@dataclass
class Tcp:
    t: float
    total_retrans: int
    lost: int
    unacked: int
    rtt_us: int
    rttvar_us: int
    cwnd: int
    rwnd_limited_us: int
    snd_wnd: int
    bytes_retrans: int
    rto_us: int


@dataclass
class Run:
    cal: Dict[str, List[Tuple[float, float, float]]] = field(default_factory=dict)
    frames: List[Frame] = field(default_factory=list)
    tcp: List[Tcp] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    end: Optional[str] = None
    unmatched_pongs: int = 0


def parse(text: str) -> Run:
    run = Run()
    by_t0: Dict[str, Frame] = {}
    pongs: List[Tuple[str, float, float]] = []
    for line in text.splitlines():
        p = line.split()
        if not p:
            continue
        try:
            if p[0] == "CAL" and len(p) == 5:
                run.cal.setdefault(p[1], []).append((float(p[2]), float(p[3]), float(p[4])))
            elif p[0] == "F" and len(p) == 8:
                f = Frame(
                    int(p[1]), float(p[2]), float(p[3]), int(p[4]), int(p[5]), int(p[6]), int(p[7])
                )
                run.frames.append(f)
                by_t0[p[3]] = f
            elif p[0] == "P" and len(p) == 4:
                pongs.append((p[1], float(p[2]), float(p[3])))
            elif p[0] == "T" and len(p) == 12:
                run.tcp.append(Tcp(float(p[1]), *(int(x) for x in p[2:])))
            elif p[0] == "E":
                run.errors.append(" ".join(p[1:]))
            elif p[0] == "END":
                run.end = " ".join(p[1:])
        except ValueError:
            continue
    for key, t1, t3 in pongs:
        f = by_t0.get(key)
        if f is None:
            run.unmatched_pongs += 1
            continue
        f.t1_dev, f.t3 = t1, t3
    return run


@dataclass
class ClockFit:
    """device_ms = host_ms + offset(host_ms), offset linear in host time."""

    t_ref: float
    off_ref: float
    drift: float  # ms of offset per host ms (ppm * 1e-6)
    rtt_ms: float  # best calibration RTT (the fit's uncertainty is ~rtt/2)

    def offset(self, t_host: float) -> float:
        return self.off_ref + self.drift * (t_host - self.t_ref)

    def to_host(self, t_dev: float) -> float:
        # Solve t_dev = t + off(t) for t (one fixed-point step is exact for linear off).
        t = t_dev - self.off_ref
        return t_dev - self.offset(t)


def _phase_offset(
    samples: Sequence[Tuple[float, float, float]],
) -> Optional[Tuple[float, float, float]]:
    """(host time, offset, min rtt) from a calibration burst: the median offset of the
    lowest-RTT third of the pings (least queueing; NTP's clock filter)."""
    pts = [(t3 - t0, t1 - (t0 + t3) / 2.0, (t0 + t3) / 2.0) for t0, t1, t3 in samples if t3 >= t0]
    if not pts:
        return None
    pts.sort()
    best = pts[: max(1, len(pts) // 3)]
    return (
        statistics.median(b[2] for b in best),
        statistics.median(b[1] for b in best),
        best[0][0],
    )


def fit_clock(run: Run) -> Optional[ClockFit]:
    pre = _phase_offset(run.cal.get("pre", []))
    post = _phase_offset(run.cal.get("post", []))
    if pre is None and post is None:
        return None
    if pre is None or post is None or post[0] - pre[0] < 1000.0:
        t, off, rtt = pre or post  # type: ignore[misc]
        return ClockFit(t, off, 0.0, rtt)
    drift = (post[1] - pre[1]) / (post[0] - pre[0])
    return ClockFit(pre[0], pre[1], drift, min(pre[2], post[2]))


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * q / 100.0
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


@dataclass
class Stall:
    at_seq: int  # first frame applied after the gap
    gap_ms: float
    catchup: int  # frames applied back-to-back right after it
    retrans: int  # sender TCP retransmissions in [gap start - 50 ms, gap end]
    rwnd_ms: float  # time the sender was receive-window-limited in that span
    kern_q: int  # sender kernel backlog (unsent+unacked bytes) when the gap ended
    cause: str


@dataclass
class Stats:
    fps_target: float
    frames_sent: int
    frames_applied: int
    frames_skipped: int
    seconds: float
    lat_ms: List[float]
    intervals_ms: List[float]
    stalls: List[Stall]
    retrans: int
    bytes_retrans: int
    rwnd_limited_ms: float
    max_kern_q: int
    max_app_q: int
    clock_rtt_ms: float
    drift_ppm: float
    end: Optional[str]
    errors: int

    @property
    def fps_applied(self) -> float:
        return self.frames_applied / self.seconds if self.seconds > 0 else 0.0

    def lat(self, q: float) -> float:
        return percentile(self.lat_ms, q)

    @property
    def jitter_ms(self) -> float:
        """Std-dev of the device-side inter-apply interval."""
        return statistics.pstdev(self.intervals_ms) if len(self.intervals_ms) > 1 else 0.0

    def stall_causes(self) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for s in self.stalls:
            out[s.cause] = out.get(s.cause, 0) + 1
        return out


def _tcp_window(tcp: Sequence[Tcp], t_lo: float, t_hi: float) -> Tuple[int, float]:
    """(retransmissions, receive-window-limited ms) accrued in (t_lo, t_hi]: the delta
    between the last sample at/before t_lo and the first at/after t_hi."""
    if not tcp:
        return 0, 0.0
    before = None
    after = None
    for row in tcp:
        if row.t <= t_lo:
            before = row
        if row.t >= t_hi and after is None:
            after = row
    before = before or tcp[0]
    after = after or tcp[-1]
    return (
        max(0, after.total_retrans - before.total_retrans),
        max(0, after.rwnd_limited_us - before.rwnd_limited_us) / 1000.0,
    )


def analyze(
    run: Run,
    fps: float,
    stall_ms: float = 100.0,
    catchup_ms: Optional[float] = None,
) -> Optional[Stats]:
    """Per-frame latency, apply-interval jitter and attributed stalls; None when no
    clock fit could be made (no calibration pongs: the device never answered)."""
    clock = fit_clock(run)
    if clock is None:
        return None
    period = 1000.0 / fps
    catchup_ms = period / 3.0 if catchup_ms is None else catchup_ms
    applied = [f for f in run.frames if f.t1_dev is not None]
    lat: List[float] = []
    t_apply: List[Tuple[int, float, Frame]] = []
    for f in applied:
        th = clock.to_host(f.t1_dev)  # type: ignore[arg-type]
        lat.append(th - f.t_sched)  # from capture time: a held frame's wait counts
        t_apply.append((f.seq, th, f))
    t_apply.sort()
    intervals: List[float] = []
    stalls: List[Stall] = []
    i = 1
    while i < len(t_apply):
        gap = t_apply[i][1] - t_apply[i - 1][1]
        intervals.append(gap)
        if gap > stall_ms:
            j = i + 1
            while j < len(t_apply) and t_apply[j][1] - t_apply[j - 1][1] < catchup_ms:
                j += 1
            catch = j - i - 1
            t_lo, t_hi = t_apply[i - 1][1], t_apply[i][1]
            rt, rw = _tcp_window(run.tcp, t_lo - 50.0, t_hi)
            kq = t_apply[i][2].kern_q
            if rt > 0:
                cause = "tcp_retransmit"
            elif rw >= gap * 0.5:
                cause = "device_window_full"
            else:
                cause = "device_busy"
            stalls.append(Stall(t_apply[i][0], gap, catch, rt, rw, kq, cause))
        i += 1
    sent = len(run.frames)
    if sent:
        seconds = (run.frames[-1].t_sched - run.frames[0].t_sched) / 1000.0 + 1.0 / fps
    else:
        seconds = 0.0
    tcp0, tcp1 = (run.tcp[0], run.tcp[-1]) if run.tcp else (None, None)
    return Stats(
        fps_target=fps,
        frames_sent=sent,
        frames_applied=len(applied),
        frames_skipped=sum(f.skipped_before for f in run.frames),
        seconds=seconds,
        lat_ms=lat,
        intervals_ms=intervals,
        stalls=stalls,
        retrans=(tcp1.total_retrans - tcp0.total_retrans) if tcp0 and tcp1 else 0,
        bytes_retrans=(tcp1.bytes_retrans - tcp0.bytes_retrans) if tcp0 and tcp1 else 0,
        rwnd_limited_ms=(
            ((tcp1.rwnd_limited_us - tcp0.rwnd_limited_us) / 1000.0) if tcp0 and tcp1 else 0.0
        ),
        max_kern_q=max((f.kern_q for f in run.frames), default=0),
        max_app_q=max((f.app_q for f in run.frames), default=0),
        clock_rtt_ms=clock.rtt_ms,
        drift_ppm=clock.drift * 1e6,
        end=run.end,
        errors=len(run.errors),
    )


@dataclass
class Policy:
    """Gate thresholds. Defaults are deliberately loose (a baseline-measuring gate that
    only fails on a broken stream); tighten as the sender/device/TCP fixes land."""

    min_applied_ratio: float = 0.9
    max_p99_ms: float = 2000.0
    max_stalls_per_min: float = 1e9


def run_status(stats: Optional[Stats], policy: Policy = Policy()) -> Tuple[str, str]:
    """('PASS'|'FAIL'|'SKIP', reason). SKIP = no baseline (the device never answered a
    calibration ping) -> infra, not a regression. A session that dropped mid-stream or
    applied too few frames is a FAIL."""
    if stats is None:
        return "SKIP", "no calibration pongs (device never answered)"
    if stats.frames_sent == 0:
        return "SKIP", "no frames sent"
    if stats.end and stats.end != "done":
        return "FAIL", f"stream ended early: {stats.end}"
    ratio = stats.frames_applied / max(1, stats.frames_sent)
    if ratio < policy.min_applied_ratio:
        return "FAIL", f"applied {ratio:.2%} of frames (< {policy.min_applied_ratio:.0%})"
    p99 = stats.lat(99)
    if p99 > policy.max_p99_ms:
        return "FAIL", f"p99 latency {p99:.0f} ms > {policy.max_p99_ms:.0f} ms"
    per_min = len(stats.stalls) / max(stats.seconds / 60.0, 1e-9)
    if per_min > policy.max_stalls_per_min:
        return "FAIL", f"{per_min:.1f} stalls/min > {policy.max_stalls_per_min}"
    return "PASS", "ok"


def result_line(stats: Optional[Stats], status: Tuple[str, str]) -> str:
    verdict, reason = status
    if stats is None:
        return f"RESULT verdict={verdict} reason={reason.replace(' ', '_')}"
    causes = ",".join(f"{k}:{v}" for k, v in sorted(stats.stall_causes().items())) or "-"
    gaps = sorted((s.gap_ms for s in stats.stalls), reverse=True)
    return (
        f"RESULT verdict={verdict} fps_target={stats.fps_target:g} "
        f"fps_applied={stats.fps_applied:.2f} sent={stats.frames_sent} "
        f"applied={stats.frames_applied} skipped={stats.frames_skipped} "
        f"seconds={stats.seconds:.1f} "
        f"lat_p50_ms={stats.lat(50):.1f} lat_p95_ms={stats.lat(95):.1f} "
        f"lat_p99_ms={stats.lat(99):.1f} lat_max_ms={max(stats.lat_ms, default=float('nan')):.1f} "
        f"ivl_p50_ms={percentile(stats.intervals_ms, 50):.1f} "
        f"ivl_p99_ms={percentile(stats.intervals_ms, 99):.1f} "
        f"ivl_max_ms={max(stats.intervals_ms, default=float('nan')):.1f} "
        f"jitter_ms={stats.jitter_ms:.1f} stalls={len(stats.stalls)} stall_causes={causes} "
        f"worst_gaps_ms={','.join(f'{g:.0f}' for g in gaps[:5]) or '-'} "
        f"retrans={stats.retrans} bytes_retrans={stats.bytes_retrans} "
        f"rwnd_limited_ms={stats.rwnd_limited_ms:.0f} max_kern_q={stats.max_kern_q} "
        f"max_app_q={stats.max_app_q} clock_rtt_ms={stats.clock_rtt_ms:.1f} "
        f"drift_ppm={stats.drift_ppm:.1f} end={stats.end} reason={reason.replace(' ', '_')}"
    )
