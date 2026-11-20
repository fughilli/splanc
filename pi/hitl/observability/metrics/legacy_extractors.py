"""Metric rows from the lines HITL gates printed before they emitted HITL_METRIC.

Each extractor reads one test section's lines (ANSI/timestamps already stripped)
and returns records in the hitl_metrics schema (gate, metric, unit, value and,
when the line or the gate's code gives one, limit/cmp/ok/phase/stat/n). They
backfill the dashboard from ~90 days of CI logs, and keep a gate that is not
instrumented yet on it. A gate that emits a HITL_METRIC for the same
(gate, metric) wins: the ingest drops the legacy row then.

Limits that the log line does not print are the gate's constant as of this
writing (file:line in the comment); `docs/hitl/gate-thresholds.md` has the audit.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Callable, Iterable

Extractor = Callable[[str, list[str]], Iterable[dict]]
_REGISTRY: list[tuple[re.Pattern, Extractor]] = []


def extractor(target_re: str):
    """Register fn for test targets whose name (after the colon) matches target_re."""

    def deco(fn: Extractor) -> Extractor:
        _REGISTRY.append((re.compile(target_re), fn))
        return fn

    return deco


def _ok(value: float, limit: float | None, cmp: str) -> bool | None:
    if limit is None:
        return None
    return {
        "<=": value <= limit,
        "<": value < limit,
        ">=": value >= limit,
        ">": value > limit,
    }[cmp]


def rec(
    gate: str,
    metric: str,
    value: float,
    unit: str,
    limit: float | None = None,
    cmp: str = "<=",
    **kw,
) -> dict:
    r = {"v": 1, "gate": gate, "metric": metric, "unit": unit, "value": float(value)}
    if limit is not None:
        r["limit"] = float(limit)
        r["cmp"] = cmp
        r["ok"] = _ok(float(value), float(limit), cmp)
    for k, v in kw.items():
        if v is not None and v != "":
            r[k] = v
    return r


def extract(target: str, gate: str, lines: list[str]) -> list[dict]:
    name = target.rsplit(":", 1)[-1]
    out: list[dict] = []
    for pat, fn in _REGISTRY:
        if pat.search(name):
            try:
                out.extend(fn(gate, lines))
            except Exception as e:  # a malformed log must not kill the ingest
                out.append({"_error": f"{fn.__name__}: {e!r}"})
    return [r for r in out if "_error" not in r]


def _json_after(line: str, tag: str):
    i = line.find(tag)
    if i < 0:
        return None
    try:
        return json.loads(line[i + len(tag) :].strip())
    except ValueError:
        return None


def _kv(s: str) -> dict[str, str]:
    return dict(re.findall(r"(\w+)=(\S+)", s))


def _num(s: str | None) -> float | None:
    if s is None:
        return None
    m = re.match(r"^-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


# ---- live_latency (live_latency_core.verdict_lan: p50 <= 1 frame + 50 ms, p99 <=
# 3 frames + 120 ms; the RESULT line prints both budgets) ---------------------------
_LL_STATS = re.compile(
    r"(?P<w>all|first|last)\[n=(?P<n>\d+) p50=(?P<p50>[\d.]+)ms p99=(?P<p99>[\d.]+)ms max=(?P<max>[\d.]+)ms\]"
)


@extractor(r"^live_latency")
def live_latency(gate, lines):
    for line in lines:
        if not line.startswith("RESULT live_latency ") or " | RESULT" in line:
            continue
        kv = _kv(line)
        sender = kv.get("sender", "")
        stats = {m.group("w"): m for m in _LL_STATS.finditer(line)}
        a = stats.get("all")
        if not a or int(a.group("n")) == 0:
            continue
        b50, b99 = _num(kv.get("budget_p50")), _num(kv.get("budget_p99"))
        n = int(a.group("n"))
        g = "live_latency"
        yield rec(g, "control_lag", a.group("p50"), "ms", b50, phase=sender, stat="p50", n=n)
        yield rec(g, "control_lag", a.group("p99"), "ms", b99, phase=sender, stat="p99", n=n)
        yield rec(g, "control_lag", a.group("max"), "ms", phase=sender, stat="max", n=n)


# ---- video_latency (video_latency_core: p99 <= 2000 ms, applied >= 0.9) ---------
VIDEO_P99_MS = 2000.0
VIDEO_APPLIED_MIN = 0.9


@extractor(r"^video_latency")
def video_latency(gate, lines):
    mode = ""
    for line in lines:
        m = re.search(r"\[video-latency\] run \d+ (\S+) ->", line)
        if m:
            mode = m.group(1)
            continue
        if not (line.startswith("RESULT verdict=") and "lat_p50_ms=" in line):
            continue
        kv = _kv(line)
        g = "video_latency"
        for stat in ("p50", "p95", "p99", "max"):
            v = _num(kv.get(f"lat_{stat}_ms"))
            if v is not None:
                lim = VIDEO_P99_MS if stat == "p99" else None
                yield rec(g, "frame_latency", v, "ms", lim, phase=mode, stat=stat)
        sent, applied = _num(kv.get("sent")), _num(kv.get("applied"))
        if sent:
            yield rec(
                g, "applied_ratio", applied / sent, "pct", VIDEO_APPLIED_MIN, ">=", phase=mode
            )
        stalls = _num(kv.get("stalls"))
        if stalls is not None:
            yield rec(g, "stalls", stalls, "count", phase=mode)


# ---- video_stream (wss_stream: fps >= --min-fps 10) -----------------------------
@extractor(r"^video_stream")
def video_stream(gate, lines):
    for line in lines:
        if line.startswith("[video-stream] RESULT verdict="):
            kv = _kv(line)
            fps, lo = _num(kv.get("fps")), _num(kv.get("min"))
            if fps is not None:
                yield rec("video_stream", "stream_fps", fps, "fps", lo, ">=")


# ---- rejoin_loop (per boot lease <= --window 40 s; p95 <= --p95-limit 20 s) ------
REJOIN_WINDOW_MS = 40_000.0
REJOIN_P95_MS = 20_000.0


@extractor(r"^rejoin_loop")
def rejoin_loop(gate, lines):
    for line in lines:
        b = _json_after(line, "BOOT_JSON ")
        if isinstance(b, dict) and isinstance(b.get("lease_ms"), (int, float)):
            yield rec("rejoin_loop", "lease_latency", b["lease_ms"], "ms", REJOIN_WINDOW_MS)
            continue
        if line.startswith("RESULT ") and "p95_ms=" in line and "boots=" in line:
            kv = _kv(line)
            v = _num(kv.get("p95_ms"))
            if v is not None:
                n = _num(kv.get("boots"))
                yield rec(
                    "rejoin_loop",
                    "lease_latency",
                    v,
                    "ms",
                    REJOIN_P95_MS,
                    stat="p95",
                    n=int(n) if n else None,
                )


# ---- ota_gate (ota_core: handoff <= 120 s, finish <= 60 s, healthy <= 240 s / 300
# s for the crash + unhealthy phases, <= 8 resumes) ------------------------------
_OTA_PHASE = re.compile(
    r"^\[(?P<phase>[a-z_]+)\] outcome=(?P<outcome>\S+) in (?P<s>\d+(?:\.\d+)?)s (?P<js>\{.*\})?$"
)
OTA_LIMITS = {"handoff_s": 120.0, "finish_s": 60.0, "healthy_s": 240.0}


@extractor(r"^ota_gate$")
def ota_gate(gate, lines):
    for line in lines:
        m = _OTA_PHASE.match(line)
        if not m:
            continue
        ph = m.group("phase")
        g = "ota_gate"
        yield rec(g, "phase_duration", m.group("s"), "s", phase=ph)
        try:
            d = json.loads(m.group("js") or "{}")
        except ValueError:
            d = {}
        for key, metric in (
            ("handoff_s", "handoff_duration"),
            ("transfer_s", "transfer_duration"),
            ("finish_s", "finish_duration"),
            ("boot_s", "boot_duration"),
            ("healthy_s", "healthy_duration"),
        ):
            v = d.get(key)
            if not isinstance(v, (int, float)):
                continue
            lim = OTA_LIMITS.get(key)
            if key == "healthy_s" and ph.startswith(("crash", "unhealthy")):
                lim = 300.0
            yield rec(g, metric, v, "s", lim, phase=ph)
        if isinstance(d.get("resumes"), int):
            yield rec(g, "resumes", d["resumes"], "count", 8, phase=ph)
        size, xfer = d.get("bytes_sent") or d.get("size"), d.get("transfer_s")
        if isinstance(size, (int, float)) and isinstance(xfer, (int, float)) and xfer > 0:
            yield rec(g, "throughput", size / 1024.0 / xfer * 8, "kbps", phase=ph)


# ---- no_reboot_no_park (core: slow fps >= 1.0, control p50 <= 3 s, max <= 15 s) --
@extractor(r"^no_reboot_no_park")
def no_reboot_no_park(gate, lines):
    for line in lines:
        if not (line.startswith("RESULT ") and "slow_fps=" in line):
            continue
        kv = _kv(line)
        g = "no_reboot_no_park"
        v = _num(kv.get("slow_fps"))
        if v is not None:
            yield rec(g, "slow_effect_fps", v, "fps", 1.0, ">=")
        v = _num(kv.get("control_p50"))
        if v is not None:
            yield rec(g, "control_latency", v, "s", 3.0, stat="p50")
        v = _num(kv.get("control_max"))
        if v is not None:
            yield rec(g, "control_latency", v, "s", 15.0, stat="max")


# ---- heavy_effect_reachability (core: handshake <= 8 s; rejoin/boot first ok <= 60
# s; a session dies after a 4 s silence + 2 missed 5 s pings) --------------------
_HEAVY_PHASE = re.compile(r"^\s+(?P<phase>idle|rejoin|boot|session): (?P<js>\{.*)")


@extractor(r"^heavy_effect_reachability")
def heavy_effect_reachability(gate, lines):
    g = "heavy_effect_reachability"
    for line in lines:
        m = _HEAVY_PHASE.match(line)
        if not m:
            continue
        try:
            d = json.loads(m.group("js").split(" console=", 1)[0])
        except ValueError:
            continue
        ph = m.group("phase")
        if ph == "idle":
            for t, cat in zip(d.get("times_s") or [], d.get("cats") or []):
                if cat == "ok":
                    yield rec(g, "connect_latency", t, "s", 8.0, phase="idle")
        elif ph in ("rejoin", "boot") and d.get("first_ok_s") is not None:
            yield rec(g, "first_connect_after", d["first_ok_s"], "s", 60.0, phase=ph)
        elif ph == "session" and d.get("max_silence_s") is not None:
            yield rec(g, "max_silence", d["max_silence_s"], "s", phase="session")


# ---- map_upload bulk readback (map_upload_core: p90 <= 1.0 s, a chunk unanswered
# 5 s = DEVICE SILENT) ----------------------------------------------------------
@extractor(r"^map_upload")
def map_upload(gate, lines):
    for line in lines:
        m = re.search(
            r"\[bulk\] (?:PASS|FAIL): .*?(\d+) chunks p50=(\d+)ms p90=(\d+)ms max=(\d+)ms", line
        )
        if m:
            n = int(m.group(1))
            g = "map_upload"
            yield rec(g, "bulk_chunk_latency", m.group(2), "ms", stat="p50", n=n)
            yield rec(g, "bulk_chunk_latency", m.group(3), "ms", 1000.0, stat="p90", n=n)
            yield rec(g, "bulk_chunk_latency", m.group(4), "ms", 5000.0, stat="max", n=n)


# ---- wifi_cadence (core: a frame period deviating > max(3000 us, 2% median, 1.5x
# steady p99.9) is an excursion; the threshold per load is in WIFI_CADENCE_JSON) --
_WC_LINE = re.compile(r"^\s+(?P<load>light|heavy)/(?P<phase>\w+): wire=(?P<js>\{.*?\}) device=")


@extractor(r"^wifi_cadence")
def wifi_cadence(gate, lines):
    thresholds: dict[str, float] = {}
    for line in lines:
        d = _json_after(line, "WIFI_CADENCE_JSON ")
        if isinstance(d, dict):
            for load, r in (d.get("results") or {}).items():
                t = (r.get("baseline") or {}).get("threshold_us")
                if isinstance(t, (int, float)):
                    thresholds[load] = t
    for line in lines:
        m = _WC_LINE.match(line)
        if not m:
            continue
        try:
            w = json.loads(m.group("js"))
        except ValueError:
            continue
        load = m.group("load")
        ph = f"{load}/{m.group('phase')}"
        if w.get("dev_max_us") is not None:
            yield rec(
                "wifi_cadence",
                "frame_period_dev_max",
                w["dev_max_us"],
                "us",
                thresholds.get(load),
                phase=ph,
            )


# ---- tls_churn / loaded_tls (tls_churn_core: final round recovers within the 40 s
# --recover-window; earlier slow rounds are tolerated) ----------------------------
_RECOVERED = re.compile(r"^\[round (?P<i>\d+)\] wss RECOVERED (?P<s>[\d.]+)s after the")
_NOT_RECOVERED = re.compile(r"^\[round (?P<i>\d+)\] wss did NOT recover within (?P<s>[\d.]+)s")


@extractor(r"^(tls_churn|loaded_tls)")
def tls_recovery(gate, lines):
    for line in lines:
        m = _RECOVERED.match(line)
        if m:
            yield rec(gate, "wss_recovery", m.group("s"), "s", 40.0)
            continue
        m = _NOT_RECOVERED.match(line)
        if m:
            yield rec(gate, "wss_recovery", m.group("s"), "s", 40.0, ok=False)


# ---- e2e time sync (sync.py: a min-RTT sample above 2000 ms is implausible) -----
@extractor(r"^e2e")
def e2e(gate, lines):
    for line in lines:
        m = re.search(r"\[ws\] TIME SYNC OK .*? rtt=([\d.]+)ms", line)
        if m:
            yield rec("e2e", "time_sync_rtt", m.group(1), "ms", 2000.0)


# ---- stable_identity (core: a second client refused within 5 s) -----------------
@extractor(r"^stable_identity")
def stable_identity(gate, lines):
    for line in lines:
        i = line.find(" refusal=")
        if line.startswith("  mdns=") and i > 0:
            try:
                d = json.loads(line[i + len(" refusal=") :])
            except ValueError:
                continue
            if isinstance(d.get("second_s"), (int, float)):
                yield rec("stable_identity", "extra_client_refusal", d["second_s"], "s", 5.0)


# ---- preconnect (preconnect_probe: every socket step within 15 s) ----------------
@extractor(r"^preconnect")
def preconnect(gate, lines):
    for line in lines:
        d = _json_after(line, "[probe] ")
        if not isinstance(d, dict):
            continue
        for key, metric in (("fresh_s", "fresh_dial"), ("get_s", "idle_get")):
            if isinstance(d.get(key), (int, float)):
                yield rec("preconnect", metric, d[key], "s", 15.0)


# ---- ble_capture_e2e (each request's reply within 40 s; the RTT is the BLE
# write -> notification round trip, desk D-75) ------------------------------------
_BLE_CAP = re.compile(
    r"^\[ble-capture\] (?P<label>\S+(?:\(\w+\))?)\s+-> (?P<type>\w+)\s+(?P<ms>[\d.]+) ms"
)


@extractor(r"^ble_capture_e2e")
def ble_capture_e2e(gate, lines):
    for line in lines:
        m = _BLE_CAP.match(line)
        if m:
            label = m.group("label")
            kind = re.sub(r"\d+$", "", label.split("(")[0])  # stage1 -> stage
            yield rec(
                "ble_capture_e2e", "ble_request_rtt", m.group("ms"), "ms", 40000.0, phase=kind
            )
        m2 = re.search(
            r"\[ble-capture\] capture requests: .*?map push: \d+ windows in [\d.]+ s \(([\d.]+) kB/s\)",
            line,
        )
        if m2:
            yield rec("ble_capture_e2e", "map_push_throughput", float(m2.group(1)) * 8, "kbps")


# ---- improv_fresh_join (IMPROV_FRESH_JOIN_JSON). The gate's budgets (--join-budget
# 20 s, --absent-budget 45 s) run inside the rig provisioner from its write ack; the
# log only has each phase's `wall_s`, which also holds the BLE scan + connect (~10-14
# s), so it is trended without a limit (the gate's own emission carries the budget).
@extractor(r"^improv_fresh_join")
def improv_fresh_join(gate, lines):
    for line in lines:
        d = _json_after(line, "IMPROV_FRESH_JOIN_JSON ")
        if not isinstance(d, dict):
            continue
        for name, p in (d.get("phases") or {}).items():
            if not isinstance(p, dict) or not isinstance(p.get("wall_s"), (int, float)):
                continue
            err = str(p.get("error") or "")
            if "BLE transport failed" in err or "no Improv device" in err:
                continue  # infra: never reached the firmware
            yield rec("improv_fresh_join", "phase_wall_time", p["wall_s"], "s", phase=name)
        serial = d.get("serial") or {}
        if isinstance(serial.get("ble_drops"), int):
            yield rec("improv_fresh_join", "ble_drops_unleased", serial["ble_drops"], "count")


# ---- ble_rename (branch agent/ble-live-rename; firmware-clock rename -> on air
# within --budget 5 s, per phase) --------------------------------------------------
@extractor(r"^ble_rename")
def ble_rename(gate, lines):
    for line in lines:
        if not (line.startswith("RESULT unit=") and " budget=" in line):
            continue
        kv = _kv(line)
        budget = _num(kv.get("budget")) or 5.0
        for ph in ("adv", "conn", "final"):
            # `<ph>_fw_s` (firmware clock, current) or `<ph>_s` (harness clock, early runs)
            v = _num(kv.get(f"{ph}_fw_s", kv.get(f"{ph}_s")))
            if v is not None:
                yield rec("ble_rename", "name_seen_latency", v, "s", budget, phase=ph)


# ---- mesh gates (branches agent/mesh-m*; manual py_binaries for now). Lines are
# `[mesh_<gate>] <phase>: {json, possibly cut at 1500-1800 chars}`, so numbers are
# pulled by key with regexes rather than json.loads. -------------------------------
MESH_FORM_MAX_S = 15.0
MESH_REJOIN_MAX_S = 45.0
MESH_SKEW_MAX_US = 10_000.0
_MESH_LINE = re.compile(r"^\[(?P<g>mesh_\w+)\] (?P<phase>[\w ,()]+?): (?P<rest>[\[{].*)$")


def _node_map(text: str, key: str) -> dict[str, float]:
    m = re.search(r"['\"]%s['\"]: \{([^{}]*)\}" % re.escape(key), text)
    if not m:
        return {}
    return {k: float(v) for k, v in re.findall(r"['\"](\w+)['\"]: (-?[\d.]+)", m.group(1))}


@extractor(r"mesh")
def mesh(gate, lines):
    for line in lines:
        m = _MESH_LINE.match(line)
        if not m:
            continue
        g, ph, rest = m.group("g"), m.group("phase"), m.group("rest")
        if ph.startswith("formation"):
            # mesh_smoke: `formation (s from key): {'c': 5.01, ...}`
            for v in re.findall(r"'\w+': ([\d.]+)", rest):
                yield rec(g, "formation", v, "s", MESH_FORM_MAX_S)
            continue
        for v in _node_map(rest, "formation_s").values():
            yield rec(g, "formation", v, "s", MESH_FORM_MAX_S)
        for v in _node_map(rest, "synced_s").values():
            yield rec(g, "time_synced", v, "s")
        if ph == "rejoin":
            b = re.search(r"'back_s': ([\d.]+)", rest)
            if b:
                yield rec(g, "rejoin", b.group(1), "s", MESH_REJOIN_MAX_S)
        sk = re.search(r'"skew": \{([^{}]*)', rest)
        if sk:
            for key, stat in (
                ("skew_median_us", "p50"),
                ("skew_p95_us", "p95"),
                ("skew_max_us", "max"),
            ):
                v = re.search(r'"%s": (-?[\d.]+)' % key, sk.group(1))
                if v:
                    lim = MESH_SKEW_MAX_US if stat == "max" else None
                    yield rec(g, "apply_skew", v.group(1), "us", lim, cmp="<", phase=ph, stat=stat)
        if g == "mesh_gateway" and ph == "deploy":
            for key in ("direct_ms", "result_ms"):
                v = re.search(r'"%s": ([\d.]+)' % key, rest)
                if v:
                    yield rec(g, "deploy_" + key[:-3] + "_latency", v.group(1), "ms")
            for v in re.findall(r'"latencyMs": (\d+)', rest):
                yield rec(g, "member_latency", v, "ms", phase="deploy")


def _literal(s: str):
    try:
        return ast.literal_eval(s)
    except (ValueError, SyntaxError):
        return None
