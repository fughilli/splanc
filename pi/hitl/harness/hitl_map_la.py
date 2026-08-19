#!/usr/bin/env python3
"""Acquire a rig's DUT→logic-analyzer channel map, interactively.

The shared FX2 analyzer taps each DUT's LED data line on a different channel
(c6-a → D6, c6-b → D7, …). The daemon needs that DUT→channel map to scope a
capture to the right wire — but which physical board (hence which channel) is
which `c6-<serial>` isn't knowable from software. This tool closes that gap:

  for each DUT on the rig:
    reserve it, flash the `dut_id` blink so its ONBOARD WS2812 (GPIO8) breathes,
    ask you "which analyzer channel is THIS board wired to?", stop the blink;
  then POST the assembled map to the daemon (POST /analyzer/channel-map), which
  applies it live AND persists it — so it sticks across reboots, no redeploy.

    bazel run //pi/hitl/harness:map_la -- --server http://<rig-ip>:8087

Starts from the rig's current map (GET /analyzer/channel-map), so DUTs you skip
keep their existing assignment. Interactive: run it where you can watch the boards.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

from hitl_client import Reservation, ReserveError
from hitl_dut_id import _default_bundle, _log, flash_blink, list_duts, stop_blink


def get_map(server: str) -> dict:
    """The rig's current DUT→channel map (POST-schema JSON), or {} if none set."""
    url = server.rstrip("/") + "/analyzer/channel-map"
    try:
        with urllib.request.urlopen(url, timeout=6) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 503:
            raise SystemExit("map_la: this rig has no logic analyzer configured — nothing to map")
        raise


def put_map(server: str, mapping: dict) -> dict:
    url = server.rstrip("/") + "/analyzer/channel-map"
    body = json.dumps(mapping).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise SystemExit(f"map_la: daemon rejected the map ({e.code}): {detail}")


def _ask_channel(name: str, current: str) -> tuple[str, list[str]] | None:
    """Prompt for the LA channel(s) this blinking DUT is wired to.

    Returns (protocol, channels) to record, or None to skip (keep any existing
    mapping). Accepts "D6" (ws2812), "D6,D7" (two-wire, e.g. spi clk,data), an
    optional "proto:" prefix ("spi:D0,D1"), or "s"/"skip"/empty to skip.
    """
    hint = f" [current: {current}]" if current else ""
    while True:
        ans = input(
            f"    which analyzer channel is {name} wired to?{hint} "
            "(e.g. D6, or 'spi:D0,D1', or 's' to skip) "
        ).strip()
        if ans.lower() in ("", "s", "skip"):
            return None
        proto = "ws2812"
        if ":" in ans:
            proto, _, ans = ans.partition(":")
            proto = proto.strip().lower() or "ws2812"
        channels = [c.strip().upper() for c in ans.split(",") if c.strip()]
        if not channels:
            _log("      (no channel parsed — try again, or 's' to skip)")
            continue
        # Normalize a bare number to Dn for convenience ("6" -> "D6").
        channels = [c if c.startswith("D") else "D" + c for c in channels]
        return proto, channels


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--server",
        default=os.environ.get("HITL_SERVER", ""),
        help="the analyzer rig's daemon URL, e.g. http://100.85.115.53:8087 (required)",
    )
    ap.add_argument(
        "--device", default="", help="just this DUT (default: walk every DUT on the rig)"
    )
    ap.add_argument("--bundle", default=_default_bundle(), help="dut_id flashbundle tar")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "map-la"))
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="acquire + print the map but don't POST it to the daemon",
    )
    args = ap.parse_args()

    if not args.server:
        raise SystemExit("map_la: --server <rig url> is required (e.g. http://<rig-ip>:8087)")
    if not args.bundle:
        raise SystemExit(
            "map_la: no dut_id flashbundle (build //firmware/dut_id:esp32c6_flashbundle)"
        )

    # Start from the rig's current map so skipped DUTs keep their assignment.
    mapping = get_map(args.server)
    _log(f"current map: {json.dumps(mapping) if mapping else '(empty)'}")

    duts = [args.device] if args.device else list_duts(args.server)
    if not duts:
        raise SystemExit(f"map_la: no DUTs on {args.server}")
    _log(f"mapping {len(duts)} DUT(s) on {args.server}: {', '.join(duts)}\n")

    for name in duts:
        _log(f"=== {name}: reserving + flashing the blink firmware… ===")
        try:
            res = Reservation(server=args.server, owner=args.owner, device=name)
            res.acquire()
        except ReserveError as e:
            _log(f"[{name}] reserve failed: {e}")
            continue
        try:
            flash_blink(res, args.bundle)
            _log(f">>> {name} is now BREATHING cyan on its onboard LED (GPIO8). Find that board.")
            cur = mapping.get(name, {})
            cur_str = ",".join(cur.get("channels", [])) if cur else ""
            try:
                choice = _ask_channel(name, cur_str)
            except EOFError:
                choice = None
            if choice is None:
                _log(f"    {name}: skipped (kept {cur_str or 'unmapped'}).")
            else:
                proto, channels = choice
                mapping[name] = {"channels": channels, "protocol": proto}
                _log(f"    {name} -> {proto} on {','.join(channels)}")
        finally:
            stop_blink(res)
            res.release()
        _log("")

    _log(f"assembled map:\n{json.dumps(mapping, indent=2)}")
    if args.dry_run:
        _log("--dry-run: not writing to the daemon.")
        return 0

    try:
        if input("write this map to the rig? [y/N] ").strip().lower() not in ("y", "yes"):
            _log("aborted — map not written.")
            return 1
    except EOFError:
        _log("no confirmation (non-interactive) — not writing. Use --dry-run to silence this.")
        return 1

    result = put_map(args.server, mapping)
    _log(f"written. rig now reports:\n{json.dumps(result, indent=2)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
