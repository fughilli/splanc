#!/usr/bin/env python3
"""Sync the private Splanc business dashboards + alert rules to Grafana Cloud.

    python3 ops/grafana/business/sync.py --dry-run            # print the plan, touch nothing
    GRAFANA_TOKEN_FILE=/workspace/credentials/grafana_local.token \\
        python3 ops/grafana/business/sync.py                  # apply

What it does, and NOTHING else (it never reads, moves or edits any other
folder, dashboard or rule):
  1. create the folder `splanc-business` ("Splanc business (private)") if missing;
  2. make it private: remove the Viewer and Editor ROLE grants on that folder
     only (org Admins keep access; the service account that created it keeps
     its creator Admin grant, which it needs for later syncs);
  3. create-or-update the four dashboards in dashboards/ inside that folder;
  4. create-or-update the alert rules in alerts.json in that folder (rule
     group `splanc-business`), routed by the DEFAULT notification policy.

Token: GRAFANA_TOKEN or GRAFANA_TOKEN_FILE (a service-account token with the
Editor role is enough: an Editor can create folders and gets Admin on the ones
it creates). URL: GRAFANA_URL (default https://splanc.grafana.net). The token
is only ever sent as a header, never printed.
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
from pathlib import Path

HERE = Path(__file__).resolve().parent
FOLDER_UID = "splanc-business"
FOLDER_TITLE = "Splanc business (private)"
LOKI_UID = "grafanacloud-logs"
DEFAULT_URL = "https://splanc.grafana.net"
REMOVE_ROLES = ("Viewer", "Editor")


# -- loading + validation (also used by the tests) -----------------------------------


def load_dashboards() -> list[dict]:
    return [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted((HERE / "dashboards").glob("*.json"))
    ]


def load_alerts() -> dict:
    return json.loads((HERE / "alerts.json").read_text(encoding="utf-8"))


def validate_dashboard(d: dict) -> list[str]:
    """Problems with one dashboard model (empty = fine)."""
    errs = []
    uid = d.get("uid", "")
    if not re.fullmatch(r"splanc-biz-[a-z0-9-]{1,30}", uid or ""):
        errs.append(f"{uid}: uid must be splanc-biz-*")
    if not str(d.get("title", "")).startswith("Splanc — "):
        errs.append(f"{uid}: title must start with 'Splanc — '")
    if d.get("id") is not None:
        errs.append(f"{uid}: id must be absent (keyed by uid)")
    if "splanc-business" not in d.get("tags", []):
        errs.append(f"{uid}: missing the splanc-business tag")
    env = next((v for v in d.get("templating", {}).get("list", []) if v.get("name") == "env"), None)
    if not env:
        errs.append(f"{uid}: no $env variable")
    elif "synthetic" in json.dumps(env.get("current", {})):
        errs.append(f"{uid}: $env must not default to synthetic")
    ids = set()
    for p in d.get("panels", []):
        pid = p.get("id")
        if pid in ids:
            errs.append(f"{uid}: duplicate panel id {pid}")
        ids.add(pid)
        g = p.get("gridPos", {})
        if not (0 <= g.get("x", -1) and g.get("x", 0) + g.get("w", 0) <= 24 and g.get("h", 0) > 0):
            errs.append(f"{uid}/{pid}: bad gridPos {g}")
        if p.get("type") in ("row", "text"):
            continue
        if not p.get("title"):
            errs.append(f"{uid}/{pid}: untitled panel")
        unit = p.get("fieldConfig", {}).get("defaults", {}).get("unit")
        if not unit:
            errs.append(f"{uid}/{pid} {p.get('title')}: no unit")
        for t in p.get("targets", []):
            if t.get("datasource", {}).get("uid") != LOKI_UID:
                errs.append(f"{uid}/{pid}: target not on {LOKI_UID}")
            expr = t.get("expr", "")
            if 'env=~"$env"' not in expr:
                errs.append(f"{uid}/{pid}: query ignores $env: {expr}")
            if expr.count("(") != expr.count(")") or expr.count("{") != expr.count("}"):
                errs.append(f"{uid}/{pid}: unbalanced query: {expr}")
            if re.search(r"\b(account|acct|ip|email|session|prompt|note)\b", expr):
                errs.append(f"{uid}/{pid}: query names an identifying field: {expr}")
    return errs


def validate_alerts(a: dict) -> list[str]:
    errs = []
    seen = set()
    for r in a.get("rules", []):
        uid = r.get("uid", "")
        if uid in seen:
            errs.append(f"duplicate rule uid {uid}")
        seen.add(uid)
        if not re.fullmatch(r"biz-[a-z0-9-]{1,36}", uid):
            errs.append(f"{uid}: uid must be biz-* (<= 40 chars)")
        if r.get("severity") not in ("page", "warn"):
            errs.append(f"{uid}: severity must be page|warn")
        if not r.get("queries") or "A" not in r["queries"]:
            errs.append(f"{uid}: needs query A")
        if ("condition" in r) == ("above" in r):
            errs.append(f"{uid}: exactly one of condition / above")
        if not re.fullmatch(r"\d+[smh]", r.get("for", "")):
            errs.append(f"{uid}: bad for")
        for k, e in r.get("queries", {}).items():
            if 'env=~"$env"' not in e:
                errs.append(f"{uid}/{k}: query ignores $env")
        if not r.get("summary"):
            errs.append(f"{uid}: no summary")
    return errs


# -- provisioning payloads ----------------------------------------------------------


def rule_payload(r: dict, *, alert_env: str, group: str, folder_uid: str = FOLDER_UID) -> dict:
    """One Grafana alert-rule provisioning object (POST/PUT /api/v1/provisioning/alert-rules)."""
    data = []
    queries = r["queries"]
    for ref, expr in queries.items():
        data.append(
            {
                "refId": ref,
                "datasourceUid": LOKI_UID,
                "queryType": "instant",
                "relativeTimeRange": {"from": 600, "to": 0},
                "model": {
                    "refId": ref,
                    "expr": expr.replace("$env", alert_env),
                    "queryType": "instant",
                    "editorMode": "code",
                },
            }
        )
    reduced = {}
    for ref in queries:
        red = f"R{ref}"
        reduced[ref] = red
        data.append(
            {
                "refId": red,
                "datasourceUid": "__expr__",
                "relativeTimeRange": {"from": 0, "to": 0},
                "model": {
                    "refId": red,
                    "type": "reduce",
                    "expression": ref,
                    "reducer": "last",
                    "settings": {"mode": "replaceNN", "replaceWithValue": 0},
                },
            }
        )
    if "condition" in r:
        expr = r["condition"]
        for ref, red in reduced.items():
            expr = expr.replace(f"${ref}", f"${red}")
        cond = {
            "refId": "C",
            "datasourceUid": "__expr__",
            "relativeTimeRange": {"from": 0, "to": 0},
            "model": {"refId": "C", "type": "math", "expression": expr},
        }
    else:
        cond = {
            "refId": "C",
            "datasourceUid": "__expr__",
            "relativeTimeRange": {"from": 0, "to": 0},
            "model": {
                "refId": "C",
                "type": "threshold",
                "expression": reduced["A"],
                "conditions": [{"evaluator": {"type": "gt", "params": [r["above"]]}}],
            },
        }
    data.append(cond)
    return {
        "uid": r["uid"],
        "title": r["title"],
        "ruleGroup": group,
        "folderUID": folder_uid,
        "condition": "C",
        "for": r["for"],
        "noDataState": "OK",
        "execErrState": "OK",
        "isPaused": False,
        "labels": {"splanc": "business", "component": r["component"], "severity": r["severity"]},
        "annotations": {"summary": r["summary"], "dashboard": "Splanc business (private)"},
        "data": data,
    }


def plan(alert_env: str | None = None) -> dict:
    """Everything sync would send (no network)."""
    a = load_alerts()
    env_re = alert_env or a["alert_env"]
    return {
        "folder": {"uid": FOLDER_UID, "title": FOLDER_TITLE},
        "remove_role_grants": list(REMOVE_ROLES),
        "dashboards": [
            {
                "dashboard": {**d, "id": None},
                "folderUid": FOLDER_UID,
                "overwrite": True,
                "message": "synced by ops/grafana/business/sync.py",
            }
            for d in load_dashboards()
        ],
        "rule_group": {"name": a["group"], "interval_s": a["interval_s"]},
        "rules": [rule_payload(r, alert_env=env_re, group=a["group"]) for r in a["rules"]],
    }


# -- the API ------------------------------------------------------------------------


class Grafana:
    def __init__(self, url: str, token: str):
        self.url, self._token = url.rstrip("/"), token

    def call(
        self, method: str, path: str, body: object | None = None, headers: dict | None = None
    ) -> tuple[int, object]:
        h = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            **(headers or {}),
        }
        data = None if body is None else json.dumps(body).encode()
        for attempt in range(8):
            req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    raw = r.read()
                    status = r.status
            except urllib.error.HTTPError as e:
                raw, status = e.read(), e.code
            try:
                parsed: object = json.loads(raw) if raw else None
            except ValueError:
                parsed = raw[:300].decode("utf8", "replace")
            # Grafana Cloud free tier wakes on access: 503 {"code":"Loading"}.
            if status == 503 and isinstance(parsed, dict) and parsed.get("code") == "Loading":
                time.sleep(10 + 5 * attempt)
                continue
            return status, parsed
        return status, parsed


def apply(g: Grafana, p: dict, log=print) -> int:
    failures = 0

    def ok(what: str, status: int, body: object, good=(200, 201, 202, 204)) -> bool:
        nonlocal failures
        if status in good:
            log(f"  ok   {what} ({status})")
            return True
        failures += 1
        msg = body.get("message") if isinstance(body, dict) else body
        log(f"  FAIL {what} ({status}): {msg}")
        return False

    log(f"folder {FOLDER_UID}")
    st, body = g.call("GET", f"/api/folders/{FOLDER_UID}")
    # A missing folder is 404, or 403 for a token whose folders:read is scoped
    # to the folders it can see.
    if st in (403, 404):
        st, body = g.call("POST", "/api/folders", {"uid": FOLDER_UID, "title": FOLDER_TITLE})
        if not ok("create folder", st, body):
            return failures
        # Grafana caches the token's permissions: the creator Admin grant on
        # the new folder can take a minute or two to show up.
        for _ in range(12):
            if (
                g.call("GET", f"/api/folders/{FOLDER_UID}")[0] == 200
                and g.call("GET", f"/api/access-control/folders/{FOLDER_UID}")[0] == 200
            ):
                break
            time.sleep(15)
    elif not ok("folder exists", st, body):
        return failures

    log("permissions (this folder only)")
    for role in p["remove_role_grants"]:
        st, body = g.call(
            "POST",
            f"/api/access-control/folders/{FOLDER_UID}/builtInRoles/{role}",
            {"permission": ""},
        )
        ok(f"remove {role} role grant", st, body)
    st, body = g.call("GET", f"/api/access-control/folders/{FOLDER_UID}")
    if st == 200 and isinstance(body, list):
        grants = sorted(
            f"{x.get('builtInRole') or x.get('userLogin') or x.get('teamId')}={x.get('permission')}"
            for x in body
        )
        log(f"  now: {', '.join(grants)}")
        leaked = [x for x in body if x.get("builtInRole") in REMOVE_ROLES]
        if leaked:
            failures += 1
            log("  FAIL folder still grants Viewer/Editor role access")

    log("dashboards")
    for d in p["dashboards"]:
        st, body = g.call("POST", "/api/dashboards/db", d)
        ok(f"{d['dashboard']['uid']} {d['dashboard']['title']}", st, body)

    log(f"alert rules (group {p['rule_group']['name']})")
    for r in p["rules"]:
        st, _ = g.call("GET", f"/api/v1/provisioning/alert-rules/{r['uid']}")
        # X-Disable-Provenance keeps the rules editable in the UI (this repo is the source).
        hdr = {"X-Disable-Provenance": "true"}
        if st == 200:
            st, body = g.call("PUT", f"/api/v1/provisioning/alert-rules/{r['uid']}", r, hdr)
        else:
            st, body = g.call("POST", "/api/v1/provisioning/alert-rules", r, hdr)
        ok(f"{r['uid']}", st, body)
    st, body = g.call(
        "PUT",
        f"/api/v1/provisioning/folder/{FOLDER_UID}/rule-groups/{p['rule_group']['name']}",
        {
            "title": p["rule_group"]["name"],
            "interval": p["rule_group"]["interval_s"],
            "rules": [g_rule for g_rule in _group_rules(g, p)],
        },
        {"X-Disable-Provenance": "true"},
    )
    ok("rule group interval", st, body)
    return failures


def _group_rules(g: Grafana, p: dict) -> list:
    st, body = g.call(
        "GET", f"/api/v1/provisioning/folder/{FOLDER_UID}/rule-groups/{p['rule_group']['name']}"
    )
    return body.get("rules", []) if st == 200 and isinstance(body, dict) else []


def token() -> str | None:
    if os.environ.get("GRAFANA_TOKEN"):
        return os.environ["GRAFANA_TOKEN"].strip()
    f = os.environ.get("GRAFANA_TOKEN_FILE")
    return Path(f).read_text().strip() if f and Path(f).exists() else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--dry-run", action="store_true", help="print the plan and the payloads; no network"
    )
    ap.add_argument("--out", help="with --dry-run: also write the payloads as JSON here")
    ap.add_argument(
        "--alert-env",
        help="regex of env labels the alert rules watch (default: alerts.json alert_env)",
    )
    args = ap.parse_args(argv)

    errs = [e for d in load_dashboards() for e in validate_dashboard(d)] + validate_alerts(
        load_alerts()
    )
    if errs:
        print("validation failed:\n  " + "\n  ".join(errs), file=sys.stderr)
        return 2
    p = plan(args.alert_env)
    if args.dry_run:
        print(f"DRY RUN against {os.environ.get('GRAFANA_URL', DEFAULT_URL)} (nothing sent)")
        print(
            f"  folder {FOLDER_UID!r} {FOLDER_TITLE!r}; remove role grants: {', '.join(p['remove_role_grants'])}"
        )
        for d in p["dashboards"]:
            n = sum(1 for x in d["dashboard"]["panels"] if x.get("type") not in ("row", "text"))
            print(f"  dashboard {d['dashboard']['uid']}: {d['dashboard']['title']} ({n} panels)")
        for r in p["rules"]:
            print(f"  alert {r['uid']} [{r['labels']['severity']}]: {r['title']}")
        if args.out:
            Path(args.out).write_text(json.dumps(p, indent=2, ensure_ascii=False))
            print(f"  payloads: {args.out}")
        return 0
    tok = token()
    if not tok:
        print("set GRAFANA_TOKEN or GRAFANA_TOKEN_FILE", file=sys.stderr)
        return 2
    failures = apply(Grafana(os.environ.get("GRAFANA_URL", DEFAULT_URL), tok), p)
    print("done" if not failures else f"{failures} step(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
