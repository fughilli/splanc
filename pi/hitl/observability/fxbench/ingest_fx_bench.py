#!/usr/bin/env python3
"""Backfill + incremental ingest of fx_bench per-effect timings from the HITL CI.

The HITL firmware perf benchmark (`fx_bench`, FUG-11) runs on a real ESP32-C6 on
every `.github/workflows/hitl.yaml` run and logs, per effect, a line like:

    empty: frame=308839 show=260600 @ 128 LEDs

`frame`/`show` are CPU cycles; the harness reports the window-MINIMUM frame (the
interrupt-free compute cost — see `stable_cycles()` in fx_bench_core.py). Goldens
drift over releases (the motivating case: JIT `sweep16` crept from a 2026-08-20
golden of 40320 to a stable ~46700, +16%, sitting on the ±15% margin ⇒ ~50% CI
flake). This pipeline turns those log lines into a time series so drift is visible
over time and across branches, caught before it flakes.

Storage/serving model (stdlib only, no write-scoped Grafana token needed): this
script fetches the `hitl_tests` job log from the GitHub REST API, parses EVERY
measurement, and writes measurements.jsonl (full history) + a compact
measurements.json/goldens.json/goldens_line.json for Grafana. The parsed dataset
is multi-MB and grows every run, so it is served as assets on the `fxbench-data`
GitHub *release* (--upload-release), not committed to git; Grafana Cloud's existing
`grafanacloud-infinity` datasource reads the fixed release download URLs. Only the
small ingest_state.json run-id ledger is committed. See README.md.

Idempotent + cheap to re-run: raw logs are cached under cache/, and each run is
keyed by (run_id); already-ingested runs are skipped unless --force. In CI the
history is seeded from the release (--seed-from-release) so the append stays
incremental across fresh checkouts.

Env:
  GITHUB_TOKEN   a GitHub token (classic PAT is fine); Authorization: token <it>.
                 Falls back to reading a token file via --token-file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = "fughilli/splanc"
API = "https://api.github.com"
WORKFLOW = "hitl.yaml"
JOB_NAME = "hitl_tests"

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
CACHE_DIR = os.path.join(HERE, "cache")

# `  <label>: frame=<n> show=<n> @ <n> LEDs`  (GHA prefixes an ISO-8601 ts).
_MEAS_RE = re.compile(
    r"(?P<label>[A-Za-z0-9_.\-]+): frame=(?P<frame>\d+) show=(?P<show>\d+) @ (?P<leds>\d+) LEDs"
)
# `[jit] pinned ON|OFF for this run` — delimits the build of the block that follows.
_JIT_RE = re.compile(r"\[jit\] pinned (?P<state>ON|OFF) for this run")
# `[golden] .../device-bench-<soc>[-jit].json: checked N effect(s), default margin ±P%`
_GOLDEN_RE = re.compile(
    r"device-bench-(?P<soc>[a-z0-9]+)(?P<jit>-jit)?\.json: checked (?P<n>\d+) effect"
)
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_TS_PREFIX_RE = re.compile(r"^\S+Z\s")


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _token(args: argparse.Namespace) -> str:
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not tok and args.token_file and os.path.exists(args.token_file):
        with open(args.token_file) as f:
            tok = f.read().strip()
    if not tok:
        _log("no GitHub token (set GITHUB_TOKEN or --token-file); anonymous is rate-limited")
    return tok or ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Stop urllib from auto-following the log redirect: the 302 points at a signed
    blob store that 403s if our GitHub Authorization header tags along. We follow it
    by hand with a bare request instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect())


def _get(url: str, token: str, *, raw: bool = False, retries: int = 5, follow_signed: bool = False):
    """GET with token auth, transparent retry on rate-limit / 5xx.

    `follow_signed`: for the job-logs endpoint, catch the 302 and re-fetch the
    signed Location URL WITHOUT the auth header (the blob store rejects it)."""
    for attempt in range(retries):
        req = urllib.request.Request(url)
        if token:
            req.add_header("Authorization", f"token {token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "splanc-fxbench-ingest")
        try:
            if follow_signed:
                try:
                    with _NO_REDIRECT_OPENER.open(req, timeout=60) as resp:
                        return resp.read()
                except urllib.error.HTTPError as e:
                    if e.code in (301, 302, 303, 307, 308):
                        loc = e.headers.get("Location")
                        bare = urllib.request.Request(loc)
                        bare.add_header("User-Agent", "splanc-fxbench-ingest")
                        with urllib.request.urlopen(bare, timeout=60) as r2:
                            return r2.read()
                    raise
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
                return data if raw else json.loads(data.decode("utf-8"))
        except urllib.error.HTTPError as e:
            # Secondary rate limit / abuse: honor Retry-After, else back off.
            if e.code in (403, 429):
                reset = e.headers.get("X-RateLimit-Reset")
                retry_after = e.headers.get("Retry-After")
                wait = 5.0
                if retry_after:
                    wait = float(retry_after)
                elif reset:
                    wait = max(1.0, float(reset) - time.time()) + 1
                wait = min(wait, 120.0)
                _log(f"  rate-limited on {url} (HTTP {e.code}); sleeping {wait:.0f}s")
                time.sleep(wait)
                continue
            if e.code in (500, 502, 503, 504):
                time.sleep(2**attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2**attempt)
    raise RuntimeError(f"GET failed after {retries} retries: {url}")


def list_runs(token: str, max_pages: int) -> list[dict]:
    """Enumerate hitl.yaml workflow runs across ALL branches, newest first."""
    runs: list[dict] = []
    for page in range(1, max_pages + 1):
        url = f"{API}/repos/{REPO}/actions/workflows/{WORKFLOW}/runs" f"?per_page=100&page={page}"
        d = _get(url, token)
        batch = d.get("workflow_runs", [])
        if not batch:
            break
        for r in batch:
            runs.append(
                {
                    "run_id": r["id"],
                    "branch": r.get("head_branch") or "",
                    "sha": r.get("head_sha") or "",
                    "created_at": r.get("created_at") or "",
                    "conclusion": r.get("conclusion") or "",
                    "event": r.get("event") or "",
                }
            )
        _log(f"  runs page {page}: +{len(batch)} (total {len(runs)}/{d.get('total_count')})")
        if len(batch) < 100:
            break
    return runs


def job_log(token: str, run_id: int) -> str | None:
    """Fetch and cache the hitl_tests job log for a run; return decoded text."""
    cache = os.path.join(CACHE_DIR, f"{run_id}.log")
    if os.path.exists(cache):
        with open(cache, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    jobs = _get(f"{API}/repos/{REPO}/actions/runs/{run_id}/jobs?per_page=50", token)
    job_id = None
    for j in jobs.get("jobs", []):
        if j.get("name") == JOB_NAME:
            job_id = j["id"]
            break
    if job_id is None:
        return None
    try:
        raw = _get(
            f"{API}/repos/{REPO}/actions/jobs/{job_id}/logs",
            token,
            raw=True,
            follow_signed=True,
        )
    except urllib.error.HTTPError as e:
        # 410 Gone (API) / 404 (the expired signed blob) = log no longer retained
        # (GitHub keeps logs ~90 days). Cache an empty marker so we don't retry it.
        if e.code in (404, 410):
            _log(f"  run {run_id}: log unavailable (HTTP {e.code})")
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(cache, "w", encoding="utf-8") as f:
                f.write("")
            return ""
        raise
    text = raw.decode("utf-8", errors="replace")
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def _clean(line: str) -> str:
    return _TS_PREFIX_RE.sub("", _ANSI_RE.sub("", line)).rstrip()


def parse_log(text: str) -> tuple[list[dict], list[dict]]:
    """Parse a job log into (measurements, goldens).

    Segments the log into blocks: each fx_bench invocation prints `[jit] pinned
    ON|OFF`, then its 72 measurement lines, then a `[golden] ...device-bench-
    <soc>[-jit].json` summary. We attribute each measurement's build from the most
    recent `[jit]` marker AND cross-check with the golden filename that closes the
    block. The same effect appears multiple times per run (interp + jit builds,
    fit/heldout, and bazel flaky retries) — we keep EVERY sample so the distribution
    is real. Off-margin `OFF <label> ... vs golden G (+P%, margin ±M%)` lines seed
    goldens (the committed golden files carry the authoritative full set).
    """
    measurements: list[dict] = []
    goldens: dict[tuple[str, str], dict] = {}
    cur_build = None  # "jit" | "interp"
    block_idx = 0
    seen_in_block = 0
    off_re = re.compile(
        r"OFF\s+(?P<label>\S+)\s+frame=(?P<measured>\d+) vs golden (?P<golden>\d+) "
        r"\(([+-][\d.]+)%, margin ±(?P<margin>[\d.]+)%\)"
    )
    for raw in text.splitlines():
        line = _clean(raw)
        mj = _JIT_RE.search(line)
        if mj:
            cur_build = "interp" if mj.group("state") == "OFF" else "jit"
            block_idx += 1
            seen_in_block = 0
            continue
        mg = _GOLDEN_RE.search(line)
        if mg:
            # Cross-check / correct the block's build from the golden filename.
            cur_build = "jit" if mg.group("jit") else "interp"
            continue
        mo = off_re.search(line)
        if mo:
            soc = "esp32c6"
            build = cur_build or "interp"
            goldens[(mo.group("label"), build)] = {
                "label": mo.group("label"),
                "build": build,
                "soc": soc,
                "goldenFrameCycles": int(mo.group("golden")),
                "marginPct": float(mo.group("margin")),
            }
            continue
        mm = _MEAS_RE.search(line)
        if mm:
            measurements.append(
                {
                    "label": mm.group("label"),
                    "build": cur_build or "interp",
                    "block": block_idx,
                    "sample": seen_in_block,
                    "frame": int(mm.group("frame")),
                    "show": int(mm.group("show")),
                    "leds": int(mm.group("leds")),
                    "soc": "esp32c6",
                }
            )
            seen_in_block += 1
    return measurements, list(goldens.values())


def _iso_to_epoch_ms(iso: str) -> int:
    if not iso:
        return 0
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return int(dt.timestamp() * 1000)


def load_goldens_from_repo() -> list[dict]:
    """Read the authoritative goldens committed under web/tests/testdata so the
    dashboards can overlay a reference line + margin band per effect/build."""
    root = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
    out: list[dict] = []
    for build, fname in (
        ("interp", "device-bench-esp32c6.json"),
        ("jit", "device-bench-esp32c6-jit.json"),
    ):
        path = os.path.join(root, "web", "tests", "testdata", fname)
        if not os.path.exists(path):
            continue
        with open(path) as f:
            g = json.load(f)
        margins = g.get("fxBenchMargins", {}) or {}
        default_m = float(margins.get("default", 0.10))
        per_label = margins.get("perLabel", {}) or {}
        for section in ("fit", "heldout"):
            for s in g.get(section, []) or []:
                gv = int(s.get("measuredFrameCycles", 0))
                if gv <= 0:
                    continue
                m = float(per_label.get(s["label"], default_m))
                out.append(
                    {
                        "label": s["label"],
                        "build": build,
                        "soc": g.get("soc", "esp32c6"),
                        "goldenFrameCycles": gv,
                        "goldenShowCycles": int(s.get("measuredShowCycles", 0)),
                        "ledCount": int(s.get("ledCount", 0)),
                        "marginPct": round(m * 100, 3),
                        "goldenLow": int(round(gv * (1 - m))),
                        "goldenHigh": int(round(gv * (1 + m))),
                    }
                )
    return out


# ---- release-asset storage ------------------------------------------------------
#
# The parsed dataset is multi-MB and grows every run, so it lives as GitHub release
# assets (tag `fxbench-data`) rather than in git (the repo caps committed files at
# 600 KB). The ingest seeds its history from the release's measurements.jsonl and
# re-uploads the refreshed assets; Grafana's Infinity datasource reads the fixed
# release download URLs.

RELEASE_TAG = "fxbench-data"


def _release(token: str) -> dict | None:
    try:
        return _get(f"{API}/repos/{REPO}/releases/tags/{RELEASE_TAG}", token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def seed_jsonl_from_release(token: str, jsonl_path: str) -> None:
    """If there's no local measurements.jsonl (fresh CI checkout), download the
    committed history from the release so the append is incremental, not a rebuild."""
    if os.path.exists(jsonl_path):
        return
    rel = _release(token)
    if not rel:
        return
    for a in rel.get("assets", []):
        if a.get("name") == "measurements.jsonl":
            data = _get(a["browser_download_url"], token, raw=True, follow_signed=True)
            with open(jsonl_path, "wb") as f:
                f.write(data)
            _log(f"seeded {jsonl_path} from release ({len(data)} bytes)")
            return


def upload_release_assets(token: str, out_dir: str, names: list[str]) -> None:
    """(Re)upload the derived dataset files as assets on the `fxbench-data` release,
    creating the release if needed. Deletes any existing asset of the same name
    first (the API rejects duplicate names)."""
    rel = _release(token)
    if not rel:
        body = json.dumps(
            {
                "tag_name": RELEASE_TAG,
                "name": "fx_bench dataset",
                "body": "Machine-generated fx_bench measurement dataset served to "
                "Grafana via the Infinity datasource. Auto-updated by "
                ".github/workflows/fxbench-ingest.yaml — do not edit by hand.",
                "prerelease": True,
                "make_latest": "false",
            }
        ).encode()
        req = urllib.request.Request(f"{API}/repos/{REPO}/releases", data=body, method="POST")
        req.add_header("Authorization", f"token {token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "splanc-fxbench-ingest")
        with urllib.request.urlopen(req, timeout=60) as resp:
            rel = json.loads(resp.read().decode())
        _log(f"created release {RELEASE_TAG}")
    rel_id = rel["id"]
    existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
    for name in names:
        path = os.path.join(out_dir, name)
        if not os.path.exists(path):
            continue
        if name in existing:
            dreq = urllib.request.Request(
                f"{API}/repos/{REPO}/releases/assets/{existing[name]}", method="DELETE"
            )
            dreq.add_header("Authorization", f"token {token}")
            dreq.add_header("User-Agent", "splanc-fxbench-ingest")
            try:
                urllib.request.urlopen(dreq, timeout=60).read()
            except urllib.error.HTTPError:
                pass
        with open(path, "rb") as f:
            payload = f.read()
        up = f"https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={name}"
        ureq = urllib.request.Request(up, data=payload, method="POST")
        ureq.add_header("Authorization", f"token {token}")
        ureq.add_header("Content-Type", "application/octet-stream")
        ureq.add_header("User-Agent", "splanc-fxbench-ingest")
        with urllib.request.urlopen(ureq, timeout=180) as resp:
            resp.read()
        _log(f"uploaded {name} ({len(payload)} bytes) to release {RELEASE_TAG}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-pages", type=int, default=10, help="run pages (100/page)")
    ap.add_argument("--max-runs", type=int, default=0, help="cap runs processed (0=all)")
    ap.add_argument("--token-file", default="/workspace/credentials/github_api_token.txt")
    ap.add_argument("--force", action="store_true", help="re-ingest already-seen runs")
    ap.add_argument("--out", default=DATA_DIR)
    ap.add_argument(
        "--seed-from-release",
        action="store_true",
        help="download the history from the fxbench-data release if no local jsonl",
    )
    ap.add_argument(
        "--upload-release",
        action="store_true",
        help="(re)upload the refreshed dataset as fxbench-data release assets",
    )
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    token = _token(args)

    jsonl_path = os.path.join(args.out, "measurements.jsonl")
    meta_path = os.path.join(args.out, "ingest_state.json")
    if args.seed_from_release and not args.force:
        seed_jsonl_from_release(token, jsonl_path)
    seen: set[int] = set()
    if os.path.exists(meta_path) and not args.force:
        with open(meta_path) as f:
            seen = set(json.load(f).get("ingested_run_ids", []))

    _log(f"listing {WORKFLOW} runs (up to {args.max_pages} pages)…")
    runs = list_runs(token, args.max_pages)
    if args.max_runs:
        runs = runs[: args.max_runs]
    _log(f"{len(runs)} runs enumerated; {len(seen)} already ingested")

    rows: list[dict] = []
    processed = 0
    for r in runs:
        rid = r["run_id"]
        if rid in seen and not args.force:
            continue
        text = job_log(token, rid)
        if not text:
            seen.add(rid)
            continue
        meas, log_goldens = parse_log(text)
        if not meas:
            seen.add(rid)
            continue
        ts_ms = _iso_to_epoch_ms(r["created_at"])
        for m in meas:
            rows.append(
                {
                    "ts": ts_ms,
                    "time": r["created_at"],
                    "run_id": rid,
                    "branch": r["branch"],
                    "sha": r["sha"],
                    "short_sha": r["sha"][:8],
                    "conclusion": r["conclusion"],
                    "event": r["event"],
                    **m,
                }
            )
        seen.add(rid)
        processed += 1
        _log(f"  run {rid} [{r['branch']}] {r['sha'][:8]}: +{len(meas)} samples")

    # Append new rows to the JSONL (append-only = idempotent history) …
    existing_rows: list[dict] = []
    if os.path.exists(jsonl_path) and not args.force:
        with open(jsonl_path) as f:
            existing_rows = [json.loads(x) for x in f if x.strip()]
    all_rows = existing_rows + rows
    # De-dupe defensively on (run_id, build, block, sample, label).
    dedup: dict[tuple, dict] = {}
    for x in all_rows:
        key = (x["run_id"], x.get("build"), x.get("block"), x.get("sample"), x["label"])
        dedup[key] = x
    all_rows = sorted(
        dedup.values(), key=lambda x: (x["ts"], x["run_id"], x.get("block", 0), x.get("sample", 0))
    )

    with open(jsonl_path, "w") as f:
        for x in all_rows:
            f.write(json.dumps(x, separators=(",", ":")) + "\n")

    # … and a compact single-array JSON for Grafana's Infinity datasource. Two rows
    # per sample (metric=frame|show) so one query covers both metrics. Only the
    # fields the dashboards actually select are emitted (ts/run_id/soc are dropped —
    # `time` carries the timestamp, soc is constant esp32c6) to keep the file, which
    # Grafana fetches per panel and is re-uploaded to the release each run, small.
    # The full-fidelity history lives in measurements.jsonl.
    infinity: list[dict] = []
    for x in all_rows:
        base = {
            "time": x["time"],
            "branch": x["branch"],
            "short_sha": x["short_sha"],
            "label": x["label"],
            "build": x["build"],
            "leds": x["leds"],
            "conclusion": x["conclusion"],
        }
        infinity.append({**base, "metric": "frame", "cycles": x["frame"]})
        infinity.append({**base, "metric": "show", "cycles": x["show"]})
    with open(os.path.join(args.out, "measurements.json"), "w") as f:
        json.dump(infinity, f, separators=(",", ":"))

    goldens = load_goldens_from_repo()
    with open(os.path.join(args.out, "goldens.json"), "w") as f:
        json.dump(goldens, f, indent=2)

    # Golden as a flat reference line: emit the value + margin band at the first and
    # last measurement timestamps so the drift timeseries can draw a horizontal
    # golden line + band per effect/build (a time-less row can't join a timeseries).
    if all_rows:
        t0 = min(x["time"] for x in all_rows)
        t1 = max(x["time"] for x in all_rows)
    else:
        now = datetime.now(timezone.utc).isoformat()
        t0 = t1 = now
    golden_line: list[dict] = []
    for g in goldens:
        for t in (t0, t1):
            golden_line.append(
                {
                    "time": t,
                    "label": g["label"],
                    "build": g["build"],
                    "golden": g["goldenFrameCycles"],
                    "goldenLow": g["goldenLow"],
                    "goldenHigh": g["goldenHigh"],
                    "marginPct": g["marginPct"],
                }
            )
    with open(os.path.join(args.out, "goldens_line.json"), "w") as f:
        json.dump(golden_line, f, separators=(",", ":"))

    # Written with json.dump (valid JSON: no trailing commas) + a trailing newline
    # (prettier's default). The run-id array is still emitted one id per line, which
    # prettier would re-pack to fit printWidth — so data/ is .prettierignore'd; the
    # cron-committed ledger is generated data, not prettier-shaped source.
    with open(meta_path, "w") as f:
        json.dump(
            {
                "ingested_run_ids": sorted(seen),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "total_samples": len(all_rows),
                "runs_with_data": len({x["run_id"] for x in all_rows}),
            },
            f,
            indent=2,
        )
        f.write("\n")

    if args.upload_release:
        upload_release_assets(
            token,
            args.out,
            ["measurements.json", "measurements.jsonl", "goldens.json", "goldens_line.json"],
        )

    _log(
        f"done: processed {processed} new run(s); dataset now {len(all_rows)} samples "
        f"across {len({x['run_id'] for x in all_rows})} runs, {len(goldens)} goldens."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
