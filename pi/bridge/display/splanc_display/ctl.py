"""``splanc-bridge status|new-code|identify|revoke-all|clients|revoke`` (the shell
CLI calls this).

python3 -m splanc_display.ctl status [--json]
python3 -m splanc_display.ctl new-code | identify | revoke-all [--yes]
python3 -m splanc_display.ctl clients [--json]
python3 -m splanc_display.ctl revoke <client id or its first characters> [--yes]
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from . import control
from . import status as st


def show_status(as_json: bool) -> int:
    s = st.load()
    if as_json:
        try:
            with open(st.status_path()) as f:
                sys.stdout.write(f.read().rstrip() + "\n")
            return 0
        except OSError:
            print(json.dumps({"state": st.WAITING}))
            return 1
    now = time.time()
    print(f"State:    {s.label}")
    code = s.active_code(now)
    if code:
        rem = st.fmt_remaining(code.remaining(now))
        print(f"Code:     {code.code}" + (f"   (expires in {rem})" if rem else ""))
        if code.url:
            print(f"Pair at:  {code.url}")
    if s.error:
        print(f"Error:    {s.error}")
    print(f"Clients:  {s.clients} connected, {len(s.paired)} paired")
    print(f"Fixtures: {s.players_ok}/{len(s.players)} online")
    for p in s.players:
        print(
            f"  {'ok  ' if p.ok else 'DOWN'}  {p.name}"
            + (f"  ({p.host})" if p.host and p.host != p.name else "")
        )
    print(f"LAN IP:   {s.lan_ip or '-'}")
    print(f"Relay:    {s.relay or '-'}")
    print(f"Bridge:   {s.bridge_id or '-'}")
    return 0 if s.state != st.WAITING else 1


CLIENTS_NOTE = {
    "relay_outdated": "the client list needs a relay update",
    "unknown": "the client list isn't loaded yet (bridge not connected)",
    "offline": "the relay is unreachable: this is the last list it sent",
}


def show_clients(as_json: bool) -> int:
    try:
        reply = control.send("clients")
    except control.ControlError as e:
        print(f"splanc-bridge: {e}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(reply, indent=2))
        return 0
    state = reply.get("state", "")
    clients = [c for c in reply.get("clients") or [] if isinstance(c, dict)]
    if state in CLIENTS_NOTE:
        print(f"({CLIENTS_NOTE[state]})")
    if not clients:
        if state in ("ok", "offline"):
            print("No paired clients.")
        return 0
    now = time.time()
    print(f"{'ID':<17} {'KIND':<15} {'LAST USED':<12} {'ADDED':<12} NAME")
    for c in clients:
        p = st.parse({"state": "paired", "paired_clients": [c]}).paired
        if not p:
            continue
        cl = p[0]
        used = st.fmt_ago(None if cl.last_used_at is None else now - cl.last_used_at)
        added = st.fmt_ago(None if cl.created_at is None else now - cl.created_at)
        print(
            f"{cl.id:<17} {cl.kind_label:<15} {used:<12} {added:<12} "
            + cl.label
            + ("  (live)" if cl.live else "")
        )
    print("\nRevoke one: splanc-bridge revoke <ID> (the first few characters will do)")
    return 0


def revoke(grant: str, yes: bool) -> int:
    if not yes:
        if not sys.stdin.isatty():
            print(
                f"splanc-bridge: revoke unpairs client {grant}; pass --yes to confirm",
                file=sys.stderr,
            )
            return 2
        if input(f"Unpair client {grant}? [y/N] ").strip().lower() not in ("y", "yes"):
            return 1
    try:
        reply = control.send("revoke", grant=grant, timeout=15.0)
    except control.ControlError as e:
        print(f"splanc-bridge: {e}", file=sys.stderr)
        return 1
    label = reply.get("label")
    print(f"Revoked {reply.get('revoked', grant)}" + (f" ({label})" if label else ""))
    return 0


def run(cmd: str) -> int:
    try:
        reply = control.send(cmd)
    except control.ControlError as e:
        print(f"splanc-bridge: {e}", file=sys.stderr)
        return 1
    extra = {k: v for k, v in reply.items() if k != "ok"}
    print("ok" + (" " + json.dumps(extra) if extra else ""))
    if cmd == "new_pairing_code":
        time.sleep(0.5)  # let the bridge rewrite status.json
        code = st.load().active_code(time.time())
        if code:
            print(f"Pairing code: {code.code}" + (f"  ->  {code.url}" if code.url else ""))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-bridge")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("status", help="show the bridge status")
    p.add_argument("--json", action="store_true")
    sub.add_parser("new-code", help="request a new pairing code")
    sub.add_parser("identify", help="flash every fixture")
    p = sub.add_parser("revoke-all", help="unpair every client")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("clients", help="list the paired clients")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("revoke", help="unpair one client (an ID from `clients`)")
    p.add_argument("id")
    p.add_argument("--yes", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "status":
        return show_status(a.json)
    if a.cmd == "clients":
        return show_clients(a.json)
    if a.cmd == "revoke":
        return revoke(a.id, a.yes)
    if a.cmd == "revoke-all" and not a.yes:
        if not sys.stdin.isatty():
            print(
                "splanc-bridge: revoke-all unpairs every client; pass --yes to confirm",
                file=sys.stderr,
            )
            return 2
        if input("Unpair every client? [y/N] ").strip().lower() not in ("y", "yes"):
            return 1
    return run(
        {"new-code": "new_pairing_code", "identify": "identify", "revoke-all": "revoke_all"}[a.cmd]
    )


if __name__ == "__main__":
    raise SystemExit(main())
