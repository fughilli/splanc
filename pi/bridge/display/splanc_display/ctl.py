"""``splanc-bridge status|new-code|identify|revoke-all`` (the shell CLI calls this).

python3 -m splanc_display.ctl status [--json]
python3 -m splanc_display.ctl new-code | identify | revoke-all [--yes]
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
    print(f"Clients:  {s.clients}")
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
    a = ap.parse_args(argv)
    if a.cmd == "status":
        return show_status(a.json)
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
