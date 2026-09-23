#!/usr/bin/env python3
"""Tiny read-only dashboard for a self-hosted Attic nix cache.

Attic ships no UI or /metrics, so this reads the SQLite metadata (read-only,
immutable — never locks atticd's writes) + the storage dir and serves a small
auto-refreshing HTML page. Stdlib only (no deps). Schema-introspecting, so it
survives attic column-name drift.

Run:  ATTIC_DB=/Volumes/MacMiniExt/attic/server.db \
      ATTIC_STORAGE=/Volumes/MacMiniExt/attic/storage \
      ATTIC_DASH_PORT=8081 python3 attic-dashboard.py
Then expose on the tailnet:  tailscale serve --bg --set-path /dash http://127.0.0.1:8081
"""
import html
import os
import sqlite3
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.environ.get("ATTIC_DB", "/Volumes/MacMiniExt/attic/server.db")
STORAGE = os.environ.get("ATTIC_STORAGE", "/Volumes/MacMiniExt/attic/storage")
PORT = int(os.environ.get("ATTIC_DASH_PORT", "8081"))
REFRESH = int(os.environ.get("ATTIC_DASH_REFRESH", "15"))


def _conn():
    # Open the SAME way atticd does (read-write) — a WAL database being actively
    # written can't be opened with immutable=1/mode=ro cleanly (that gave
    # "authorization denied"). PRAGMA query_only makes us a harmless reader: WAL
    # allows concurrent readers alongside atticd's writer, and we can never modify.
    con = sqlite3.connect(f"file:{DB}?mode=rw", uri=True, timeout=3)
    con.execute("PRAGMA query_only=ON")
    return con


def _cols(cur, table):
    try:
        cur.execute(f"PRAGMA table_info({table})")
        return {r[1] for r in cur.fetchall()}
    except sqlite3.Error:
        return set()


def _count(cur, table, where=""):
    try:
        cur.execute(f"SELECT COUNT(*) FROM {table} {where}")
        return cur.fetchone()[0]
    except sqlite3.Error:
        return None


def _sum(cur, table, col, where=""):
    try:
        cur.execute(f"SELECT COALESCE(SUM({col}),0) FROM {table} {where}")
        return cur.fetchone()[0]
    except sqlite3.Error:
        return None


def _first_col(present, *candidates):
    for c in candidates:
        if c in present:
            return c
    return None


def human(n):
    if n is None:
        return "n/a"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PiB"


def du_bytes(path):
    try:
        out = subprocess.run(["du", "-sk", path], capture_output=True, text=True, timeout=20)
        return int(out.stdout.split()[0]) * 1024
    except Exception:
        return None


def gather():
    d = {"ok": False, "err": None, "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        con = _conn()
        cur = con.cursor()
        cache_cols = _cols(cur, "cache")
        pub = _first_col(cache_cols, "is_public", "public")
        # per-cache path counts
        caches = []
        cur.execute(
            f"SELECT id, name{',' + pub if pub else ''} FROM cache"
            + (" WHERE deleted_at IS NULL" if "deleted_at" in cache_cols else "")
        )
        rows = cur.fetchall()
        for r in rows:
            cid, name = r[0], r[1]
            is_pub = bool(r[2]) if pub else None
            npaths = _count(cur, "object", f"WHERE cache_id={int(cid)}") or 0
            caches.append({"name": name, "public": is_pub, "paths": npaths})
        d["caches"] = sorted(caches, key=lambda c: -c["paths"])
        d["paths"] = _count(cur, "object")
        d["nars"] = _count(cur, "nar")
        d["chunks"] = _count(cur, "chunk")
        d["chunkrefs"] = _count(cur, "chunkref")
        # dedup proxy that needs no size columns: how many times the average chunk is reused
        d["reuse"] = (d["chunkrefs"] / d["chunks"]) if (d["chunks"] and d["chunkrefs"]) else None
        # sizes (best-effort, schema-drift tolerant)
        chunk_phys = _first_col(_cols(cur, "chunk"), "file_size", "compressed_size", "size")
        chunk_logical = _first_col(_cols(cur, "chunk"), "size", "uncompressed_size")
        d["phys"] = _sum(cur, "chunk", chunk_phys) if chunk_phys else None
        d["logical"] = _sum(cur, "chunk", chunk_logical) if chunk_logical else None
        d["dedup_ratio"] = (d["logical"] / d["phys"]) if (d["logical"] and d["phys"]) else None
        con.close()
        d["ok"] = True
    except Exception as e:
        d["err"] = str(e)
    d["disk"] = du_bytes(STORAGE)
    return d


CSS = """
body{background:#0d1117;color:#c9d1d9;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .25rem}.sub{color:#8b949e;margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1rem 1.25rem}
.card .n{font-size:1.9rem;font-weight:600;color:#58a6ff}
.card .l{color:#8b949e;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;
border-radius:10px;overflow:hidden}
th,td{padding:.6rem 1rem;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:600;font-size:.8rem;text-transform:uppercase}
tr:last-child td{border-bottom:none}.pub{color:#3fb950}.priv{color:#d29922}
.err{background:#3d1418;border:1px solid #f85149;color:#ffa198;padding:1rem;border-radius:10px}
a{color:#58a6ff}
"""


def render(d):
    if not d["ok"]:
        return (
            f"<div class=err><b>Can't read the cache DB:</b> "
            f"{html.escape(d['err'] or '?')}<br>DB: {html.escape(DB)}</div>"
        )
    cards = [
        ("Store paths", f"{d['paths']:,}" if d["paths"] is not None else "n/a"),
        ("On disk", human(d["disk"])),
        ("Dedup (chunk reuse)", f"{d['reuse']:.2f}×" if d["reuse"] else "n/a"),
        ("Compression ratio", f"{d['dedup_ratio']:.2f}×" if d["dedup_ratio"] else "n/a"),
        ("Chunks", f"{d['chunks']:,}" if d["chunks"] is not None else "n/a"),
        ("NARs", f"{d['nars']:,}" if d["nars"] is not None else "n/a"),
    ]
    cardhtml = "".join(
        f"<div class=card><div class=n>{html.escape(str(v))}</div>"
        f"<div class=l>{html.escape(lbl)}</div></div>"
        for lbl, v in cards
    )
    rows = ""
    for c in d["caches"]:
        badge = (
            ""
            if c["public"] is None
            else (
                "<span class=pub>● public</span>"
                if c["public"]
                else "<span class=priv>● private</span>"
            )
        )
        rows += f"<tr><td>{html.escape(c['name'])}</td><td>{c['paths']:,}</td><td>{badge}</td></tr>"
    logical = human(d["logical"]) if d["logical"] else "n/a"
    empty_row = "<tr><td colspan=3>no caches yet</td></tr>"
    head = "<tr><th>Cache</th><th>Store paths</th><th>Visibility</th></tr>"
    sub = (
        f"storage: {html.escape(STORAGE)} · logical (uncompressed): {logical} "
        f"· updated {d['ts']}"
    )
    return f"""
    <h1>Attic cache</h1>
    <div class=sub>{sub}</div>
    <div class=grid>{cardhtml}</div>
    <table><thead>{head}</thead><tbody>{rows or empty_row}</tbody></table>
    """


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.rstrip("/") in ("", "/dash"):
            body = (
                "<!doctype html><meta charset=utf-8>"
                f"<meta http-equiv=refresh content={REFRESH}>"
                f"<title>Attic</title><style>{CSS}</style>{render(gather())}"
            )
            b = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    bind = os.environ.get(
        "ATTIC_DASH_BIND", "0.0.0.0"
    )  # 0.0.0.0 so it's reachable on the tailscale node's IP
    print(f"attic-dashboard on {bind}:{PORT}  (DB={DB})")
    ThreadingHTTPServer((bind, PORT), H).serve_forever()
