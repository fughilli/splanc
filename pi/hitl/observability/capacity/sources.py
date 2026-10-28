"""Live inputs for the capacity model (stdlib only): the hitl-reserved Prometheus
series (read through Grafana's /api/ds/query), merged-PR counts and the GitHub
release that stores the dataset."""

from __future__ import annotations

import collections
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request

import capacity_model as cm

API = "https://api.github.com"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _request(
    url: str,
    *,
    token: str | None = None,
    data: bytes | None = None,
    method: str | None = None,
    headers: dict | None = None,
    auth: str = "token",
    retries: int = 4,
    timeout: float = 120,
):
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"{'Bearer' if auth == 'bearer' else 'token'} {token}"
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504, 429) and attempt + 1 < retries:
                time.sleep(2**attempt * 3)
                continue
            raise
        except urllib.error.URLError:
            if attempt + 1 < retries:
                time.sleep(2**attempt * 3)
                continue
            raise
    raise RuntimeError("unreachable")


# ---------------------------------------------------------------------------
# Prometheus via Grafana


class GrafanaProm:
    """Range queries against a Prometheus datasource through Grafana's /api/ds/query
    (works with an Editor/Viewer service-account token; no Prometheus read key)."""

    def __init__(self, url: str, token: str, datasource_uid: str = "grafanacloud-prom"):
        self.url, self.token, self.uid = url.rstrip("/"), token, datasource_uid

    def range(
        self, expr: str, start: int, end: int, step: int = cm.HOUR
    ) -> list[tuple[dict, list]]:
        body = {
            "queries": [
                {
                    "refId": "A",
                    "datasource": {"uid": self.uid},
                    "expr": expr,
                    "range": True,
                    "instant": False,
                    "intervalMs": step * 1000,
                    "interval": f"{step}s",
                    "maxDataPoints": 100000,
                }
            ],
            "from": str(start * 1000),
            "to": str(end * 1000),
        }
        # Grafana Cloud free tier suspends idle stacks: the first hit can answer
        # {"code":"Loading"}; retry a few times.
        for attempt in range(6):
            res = _request(
                self.url + "/api/ds/query",
                token=self.token,
                auth="bearer",
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"},
            )
            if res.get("code") != "Loading":
                break
            time.sleep(10)
        out = []
        a = res.get("results", {}).get("A", {})
        if a.get("error"):
            raise RuntimeError(f"query failed: {a['error']}: {expr}")
        for fr in a.get("frames", []):
            fields = fr["schema"]["fields"]
            vals = (fr.get("data") or {}).get("values") or []
            if len(fields) < 2 or len(vals) < 2:
                continue  # an empty frame (no matching series)
            labels = fields[-1].get("labels") or {}
            pts = [(int(t // 1000), v) for t, v in zip(vals[0], vals[-1]) if v is not None]
            out.append((labels, pts))
        return out


def prom_aggregates(
    query,
    hosts: list[str],
    start: int,
    end: int,
    cfg: cm.Config,
    unretried: dict[str, float] | None = None,
) -> dict:
    """Hourly aggregates from the hitl-reserved capacity series (see README.md).

    ``query(expr, start, end, step)`` returns [(labels, [(t, value)])]; a value at
    t covers (t - 1h, t], so it is booked to hour t - 1h. Unserved demand is the
    timeouts (abandoned after cfg.timeout_s) times the fraction that is not
    retried, measured on the journal backfill (``unretried``).
    """
    sel = 'host=~"%s"' % "|".join(hosts)
    unretried = unretried or {}

    def q(expr):
        return query(expr, start + cm.HOUR, end, cm.HOUR)

    demand: dict[tuple, dict] = {}

    def row(t, caps, prio):
        key = (t, caps, prio)
        if key not in demand:
            demand[key] = cm._new_demand(*key)
            demand[key]["live"] = True
        return demand[key]

    def each(expr, fn):
        for labels, pts in q(expr):
            for t, v in pts:
                h = cm._hour(t - cm.HOUR)
                if start <= h < end:
                    fn(labels, h, float(v))

    def add(field):
        def fn(lb, h, v):
            row(h, lb.get("caps_class", "mixed"), lb.get("prio_class", "dev"))[field] += v

        return fn

    by = "caps_class, prio_class"
    each(f"sum by ({by}) (increase(hitl_reservation_requests_total{{{sel}}}[1h]))", add("requests"))
    each(
        f"sum by ({by}) (increase(hitl_reservation_hold_seconds_count{{{sel}}}[1h]))", add("served")
    )
    each(f"sum by ({by}) (increase(hitl_reservation_hold_seconds_sum{{{sel}}}[1h]))", add("hold_s"))
    each(
        f"sum by ({by}) (increase(hitl_reservation_abandoned_total{{{sel}}}[1h]))", add("abandoned")
    )

    # Hold second moment from the hold histogram (bucket midpoints).
    hold_cum: dict[tuple, dict[float, float]] = collections.defaultdict(dict)
    each(
        f"sum by ({by}, le) (increase(hitl_reservation_hold_seconds_bucket{{{sel}}}[1h]))",
        lambda lb, h, v: hold_cum[
            (h, lb.get("caps_class", "mixed"), lb.get("prio_class", "dev"))
        ].__setitem__(_le(lb), v),
    )
    for key, cum in hold_cum.items():
        r = row(*key)
        prev_b, prev_c, sq = 0.0, 0.0, 0.0
        for b in sorted(cum):
            n = max(0.0, cum[b] - prev_c)
            mid = (prev_b + b) / 2 if b != float("inf") else prev_b * 1.5
            sq += n * mid * mid
            prev_b, prev_c = (b if b != float("inf") else prev_b), cum[b]
        r["hold_sq_s"] += sq

    wait_cum: dict[tuple, dict[float, float]] = collections.defaultdict(dict)
    each(
        f"sum by ({by}, result, le) (increase(hitl_reservation_wait_seconds_bucket{{{sel}}}[1h]))",
        lambda lb, h, v: wait_cum[
            (
                h,
                lb.get("caps_class", "mixed"),
                lb.get("prio_class", "dev"),
                lb.get("result", "activated"),
            )
        ].__setitem__(_le(lb), v),
    )
    for (h, caps, prio, result), cum in wait_cum.items():
        r = row(h, caps, prio)
        counts = cumulative_to_counts(cum, cm.WAIT_BUCKETS)
        key = "wait_act" if result == "activated" else "wait_ab"
        for i, n in enumerate(counts):
            r[key][i] += n
        if result != "activated":
            # timeouts: abandoned after waiting >= cfg.timeout_s (whole buckets above it)
            to = sum(
                n for i, n in enumerate(counts) if i > 0 and cm.WAIT_BUCKETS[i - 1] >= cfg.timeout_s
            )
            r["timeouts"] += to
            r["unserved"] += to * unretried.get(caps, 1.0)

    busy = []
    for labels, pts in q(
        f"sum by (caps_class, prio_class, outcome) "
        f"(increase(hitl_unit_busy_seconds_total{{{sel}}}[1h]))"
    ):
        for t, v in pts:
            h = cm._hour(t - cm.HOUR)
            if start <= h < end and v:
                busy.append(
                    {
                        "t": h,
                        "caps_class": labels.get("caps_class", "?"),
                        "prio_class": labels.get("prio_class", "dev"),
                        "outcome": labels.get("outcome", "released"),
                        "busy_s": round(float(v), 1),
                    }
                )
    avail = []
    for labels, pts in q(
        f"sum by (caps_class, host) (increase(hitl_unit_available_seconds_total{{{sel}}}[1h]))"
    ):
        for t, v in pts:
            h = cm._hour(t - cm.HOUR)
            if start <= h < end:
                avail.append(
                    {
                        "t": h,
                        "caps_class": labels.get("caps_class", "?"),
                        "host": labels.get("host", "?"),
                        "avail_s": round(min(float(v), 1e9), 1),
                    }
                )
    # How much of each hour each host's counters were actually scraped: the newest
    # sample count of its unit series x the scrape interval. The first hour after a
    # deploy is only partly covered, and a counter that has existed for 20 minutes
    # must not read as a third of a board.
    covered: dict[tuple, float] = {}
    for labels, pts in q(
        f"max by (host) (count_over_time(hitl_unit_available_seconds_total{{{sel}}}[1h]))"
    ):
        for t, v in pts:
            h = cm._hour(t - cm.HOUR)
            covered[(h, labels.get("host", "?"))] = min(
                float(cm.HOUR), float(v) * cfg.scrape_interval_s
            )
    for r in avail:
        r["covered_s"] = round(covered.get((r["t"], r["host"]), float(cm.HOUR)), 1)
    hours = sorted({r["t"] for r in avail})
    out = {
        "source": "prometheus",
        "demand": sorted(demand.values(), key=lambda d: d["t"]),
        "busy": busy,
        "avail": avail,
    }
    if hours:
        # Only hours the new series cover: before the rigs run a daemon that exports
        # them, the backfill (or nothing) speaks for that time.
        out["start"], out["end"] = hours[0], hours[-1] + cm.HOUR
    return out


def _le(labels: dict) -> float:
    v = labels.get("le", "+Inf")
    return float("inf") if v in ("+Inf", "Inf", "inf") else float(v)


def cumulative_to_counts(cum: dict[float, float], bounds: list[float]) -> list[float]:
    """Cumulative le-buckets -> per-bucket counts (+ overflow slot)."""
    out, prev = [], 0.0
    for b in bounds:
        c = cum.get(float(b), prev)
        out.append(max(0.0, c - prev))
        prev = max(prev, c)
    total = cum.get(float("inf"), prev)
    out.append(max(0.0, total - prev))
    return out


# ---------------------------------------------------------------------------
# GitHub


def merged_prs_by_day(repo: str, token: str | None, since: float) -> dict[str, int]:
    """Merged PRs per UTC day since `since` (epoch s)."""
    out: collections.Counter = collections.Counter()
    since_iso = dt.datetime.fromtimestamp(since, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for page in range(1, 30):
        prs = _request(
            f"{API}/repos/{repo}/pulls?state=closed&sort=updated&direction=desc"
            f"&per_page=100&page={page}",
            token=token,
            headers={"Accept": "application/vnd.github+json"},
        )
        if not prs:
            break
        for p in prs:
            m = p.get("merged_at")
            if m and m >= since_iso:
                out[m[:10]] += 1
        if prs[-1].get("updated_at", "") < since_iso:
            break
    return dict(out)


def _release(repo: str, token: str, tag: str) -> dict | None:
    try:
        return _request(f"{API}/repos/{repo}/releases/tags/{tag}", token=token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def release_asset_json(repo: str, token: str | None, tag: str, name: str):
    """A JSON asset of a release, or None."""
    url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def upload_release_assets(
    repo: str, token: str, tag: str, files: dict[str, bytes], *, title: str, body: str
) -> None:
    """Create the release if needed and (re)place the named assets."""
    rel = _release(repo, token, tag)
    if rel is None:
        rel = _request(
            f"{API}/repos/{repo}/releases",
            token=token,
            method="POST",
            data=json.dumps(
                {"tag_name": tag, "name": title, "body": body, "prerelease": True}
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        _log(f"created release {tag}")
    existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
    for name, payload in files.items():
        if name in existing:
            _request(
                f"{API}/repos/{repo}/releases/assets/{existing[name]}", token=token, method="DELETE"
            )
        up = f"https://uploads.github.com/repos/{repo}/releases/{rel['id']}/assets?name={name}"
        _request(
            up,
            token=token,
            method="POST",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        _log(f"uploaded {name} ({len(payload)} bytes) to release {tag}")
