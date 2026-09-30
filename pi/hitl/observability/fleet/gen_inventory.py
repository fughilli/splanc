#!/usr/bin/env python3
"""Aggregate the HITL reservation catalogs into one flat fleet-inventory JSON.

The reservation catalogs (pi/hitl/reserve/catalog*.json) are the source of truth
for the fleet's DUTs and their metadata — board type, capabilities, and the
identifying serial / port / UDID — but live Prometheus metrics carry none of that
(only per-DUT busy flags). This script flattens the catalogs (bound to hosts by
fleet.json) into one row per DUT so Grafana's Infinity datasource can render a
fleet-inventory table that shows the WHOLE fleet, including hosts (the Mac) that
aren't pushing metrics yet — the catalog is static, so a host need not be online
to appear.

Two catalog shapes are handled:

  * Static (catalog-sdr.json / catalog-phone.json / catalog-mac.json): explicit
    `components` + `units`. Each component becomes a concrete row (its resource
    type's kind + capabilities, its serial/port/UDID, and the unit it belongs to).

  * Discovery-based (catalog.json, the fleet-identical Pi catalog): no static
    components — DUTs are auto-discovered at runtime. We can't enumerate the exact
    boards, so we emit one descriptive row per discoverable chip class (from the
    `discovery` rule + `resource_types`, driven by each host's `discovery_chips`
    in fleet.json) plus a row per shared resource (the FX2 logic analyzer). The
    live-status table on the dashboard fills in the actual discovered DUT names.

Output: fleet-inventory.json — a flat array of rows Infinity reads as a table.
Grafana points at the committed copy's raw URL (the file is tiny, so unlike the
multi-MB fx_bench dataset it's committed, not a release asset); --upload-release
is offered for parity with the fx_bench pipeline but isn't the default path.

Pure stdlib. Run:  python3 gen_inventory.py            # regenerate the JSON
                   python3 gen_inventory.py --check    # CI: fail if stale
                   python3 gen_inventory.py --upload-release   # optional
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESERVE_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "reserve"))
FLEET_MAP = os.path.join(HERE, "fleet.json")
OUT_FILE = os.path.join(HERE, "fleet-inventory.json")

REPO = "fughilli/splanc"
API = "https://api.github.com"
RELEASE_TAG = "fleet-inventory"

# Env keys that identify a DUT, most-identifying first. The first present one is
# shown in the table's "identifier" column.
_ID_KEYS = [
    "HITL_IOS_UDID",
    "HITL_ANDROID_SERIAL",
    "HITL_ADAPTER_SERIAL",
    "HITL_ESP_PORT",
    "HITL_TTY",
]


def load_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _resource_type(catalog: dict, type_name: str) -> tuple[str, list[str]]:
    """(kind, capabilities) for a component/discovery type, or ("", []) if absent."""
    rt = catalog.get("resource_types", {}).get(type_name, {})
    return rt.get("kind", ""), list(rt.get("capabilities", []))


def _jtag_mac(dev: str) -> str:
    """The MAC out of a USB-JTAG by-id path, or "". Parsed off the marker (NOT by
    splitting on ':', since the MAC itself contains colons and the entry may carry
    a ':/dev/ttyACMx' container mount suffix)."""
    marker = "USB_JTAG_serial_debug_unit_"
    if marker in dev:
        return dev.split(marker, 1)[1].split("-if", 1)[0]
    return ""


def _identifier(component: dict) -> str:
    """The most-identifying serial/port/UDID for a component.

    Prefer an explicit env marker (matched by PREFIX so suffixed keys like
    HITL_ADAPTER_SERIAL_1 / HITL_TTY_1 on a rig's 2nd DUT count); otherwise parse
    the USB-JTAG serial out of the first `devices` entry."""
    env = component.get("env", {})
    for prefix in _ID_KEYS:
        for k in sorted(env):  # deterministic; the base key sorts before _1
            if (k == prefix or k.startswith(prefix)) and env[k]:
                return env[k]
    devices = component.get("devices", [])
    if devices:
        mac = _jtag_mac(devices[0])
        if mac:
            return mac
        return devices[0].split(":", 1)[0]  # non-JTAG device: strip mount suffix
    return ""


def _unit_of(catalog: dict, component_name: str) -> tuple[str, bool]:
    """(unit_name, pin_only) of the first unit that lists this component."""
    for unit in catalog.get("units", []):
        if component_name in unit.get("components", []):
            return unit.get("name", ""), bool(unit.get("pin_only", False))
    return "", False


def _row(**kw) -> dict:
    """A fleet-inventory row with a stable field order/shape."""
    return {
        "host": kw["host"],
        "board": kw["board"],
        "unit": kw.get("unit", ""),
        "dut": kw["dut"],
        "type": kw.get("type", ""),
        "kind": kw.get("kind", ""),
        "capabilities": ", ".join(kw.get("capabilities", [])),
        "identifier": kw.get("identifier", ""),
        "discovered": bool(kw.get("discovered", False)),
        "pin_only": bool(kw.get("pin_only", False)),
        "source": kw["source"],
    }


def rows_for_static_catalog(host: str, board: str, catalog: dict, source: str) -> list[dict]:
    """One row per explicit component (SDR / phone / mac catalogs)."""
    rows: list[dict] = []
    for comp in catalog.get("components", []):
        kind, caps = _resource_type(catalog, comp.get("type", ""))
        unit_name, pin_only = _unit_of(catalog, comp.get("name", ""))
        rows.append(
            _row(
                host=host,
                board=board,
                unit=unit_name,
                dut=comp.get("name", ""),
                type=comp.get("type", ""),
                kind=kind,
                capabilities=caps,
                identifier=_identifier(comp),
                discovered=False,
                pin_only=pin_only,
                source=source,
            )
        )
    return rows


def rows_for_discovery_catalog(
    host: str, board: str, catalog: dict, chips: list[str], source: str
) -> list[dict]:
    """Descriptive rows for a discovery-based Pi catalog: one per discoverable chip
    class, plus one per shared resource. The exact discovered DUTs come from the
    live-status table, not here."""
    rows: list[dict] = []
    disc = catalog.get("discovery", {})
    # chip -> name_prefix: the base discovery type uses discovery.name_prefix; a
    # chip_override contributes its own name_prefix for the overridden chip.
    prefix: dict[str, str] = {}
    if disc.get("type"):
        prefix[disc["type"]] = disc.get("name_prefix", "")
    for ov in disc.get("chip_overrides", {}).values():
        if ov.get("type"):
            prefix[ov["type"]] = ov.get("name_prefix", "")

    for chip in chips:
        kind, caps = _resource_type(catalog, chip)
        pfx = prefix.get(chip, "")
        rows.append(
            _row(
                host=host,
                board=board,
                unit="(auto-discovered)",
                dut=f"{pfx}* (auto)" if pfx else f"{chip} (auto)",
                type=chip,
                kind=kind,
                capabilities=caps,
                identifier="auto — USB-JTAG by-id",
                discovered=True,
                pin_only=False,
                source=source,
            )
        )

    for sr in catalog.get("shared_resources", []):
        driver = sr.get("config", {}).get("driver", "")
        rows.append(
            _row(
                host=host,
                board=board,
                unit="(shared)",
                dut=sr.get("name", ""),
                type=sr.get("kind", ""),
                kind=sr.get("kind", ""),
                capabilities=[sr.get("kind", "")] if sr.get("kind") else [],
                identifier=driver,
                discovered=False,
                pin_only=False,
                source=source,
            )
        )
    return rows


def build_inventory(fleet: dict, reserve_dir: str) -> list[dict]:
    """Flatten every host's catalog(s) into the ordered list of inventory rows."""
    rows: list[dict] = []
    cache: dict[str, dict] = {}

    def cat(name: str) -> dict:
        if name not in cache:
            cache[name] = load_json(os.path.join(reserve_dir, name))
        return cache[name]

    for h in fleet.get("hosts", []):
        host = h["host"]
        board = h.get("board", "")
        chips = h.get("discovery_chips", [])
        for source in h.get("catalogs", []):
            catalog = cat(source)
            if catalog.get("components"):
                rows.extend(rows_for_static_catalog(host, board, catalog, source))
            elif catalog.get("discovery", {}).get("enabled"):
                rows.extend(rows_for_discovery_catalog(host, board, catalog, chips, source))
    return rows


# ---- optional release publishing (parity with the fx_bench pipeline) ------------


def _token(args: argparse.Namespace) -> str:
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    if args.token_file and os.path.exists(args.token_file):
        with open(args.token_file) as f:
            return f.read().strip()
    sys.exit("no GitHub token: set $GITHUB_TOKEN or pass --token-file")


def _release(token: str) -> dict | None:
    req = urllib.request.Request(f"{API}/repos/{REPO}/releases/tags/{RELEASE_TAG}")
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "splanc-fleet-inventory")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def upload_release_asset(token: str, path: str) -> None:
    """(Re)upload fleet-inventory.json as an asset on the `fleet-inventory` release,
    creating the release if needed (mirrors ingest_fx_bench.upload_release_assets)."""
    name = os.path.basename(path)
    rel = _release(token)
    if not rel:
        body = json.dumps(
            {
                "tag_name": RELEASE_TAG,
                "name": "HITL fleet inventory",
                "body": "Machine-generated HITL fleet inventory served to Grafana "
                "via the Infinity datasource. Auto-updated by "
                ".github/workflows/fleet-inventory.yaml — do not edit by hand.",
                "prerelease": True,
                "make_latest": "false",
            }
        ).encode()
        req = urllib.request.Request(f"{API}/repos/{REPO}/releases", data=body, method="POST")
        req.add_header("Authorization", f"token {token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "splanc-fleet-inventory")
        with urllib.request.urlopen(req, timeout=60) as resp:
            rel = json.loads(resp.read().decode())
    rel_id = rel["id"]
    existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
    if name in existing:
        dreq = urllib.request.Request(
            f"{API}/repos/{REPO}/releases/assets/{existing[name]}", method="DELETE"
        )
        dreq.add_header("Authorization", f"token {token}")
        dreq.add_header("User-Agent", "splanc-fleet-inventory")
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
    ureq.add_header("User-Agent", "splanc-fleet-inventory")
    with urllib.request.urlopen(ureq, timeout=120) as resp:
        resp.read()
    print(f"uploaded {name} ({len(payload)} bytes) to release {RELEASE_TAG}")


def render(rows: list[dict]) -> str:
    return json.dumps(rows, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=OUT_FILE, help="output inventory JSON path")
    ap.add_argument("--fleet", default=FLEET_MAP, help="host->catalog map")
    ap.add_argument("--reserve-dir", default=RESERVE_DIR, help="dir holding catalog*.json")
    ap.add_argument(
        "--check",
        action="store_true",
        help="don't write; exit nonzero if the committed file is stale",
    )
    ap.add_argument(
        "--upload-release",
        action="store_true",
        help="(re)upload the inventory as a fleet-inventory release asset",
    )
    ap.add_argument("--token-file", default="/workspace/credentials/github_api_token.txt")
    args = ap.parse_args()

    fleet = load_json(args.fleet)
    rows = build_inventory(fleet, args.reserve_dir)
    out = render(rows)

    if args.check:
        current = ""
        if os.path.exists(args.out):
            with open(args.out) as f:
                current = f.read()
        if current != out:
            print(
                f"STALE: {args.out} is out of date — run "
                "`python3 pi/hitl/observability/fleet/gen_inventory.py` and commit.",
                file=sys.stderr,
            )
            return 1
        print(f"OK: {args.out} is up to date ({len(rows)} rows).")
        return 0

    with open(args.out, "w") as f:
        f.write(out)
    print(f"wrote {args.out} ({len(rows)} rows).")

    if args.upload_release:
        upload_release_asset(_token(args), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
