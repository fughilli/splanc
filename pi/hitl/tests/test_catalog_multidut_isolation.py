"""PR-24 — multi-DUT validation isolates test resources safely.

Two config-level isolation guarantees the reservation catalogs + the harness's
selection logic enforce so concurrent multi-DUT runs can't interfere:

  * No reservable unit shares a physical device (a board's USB-JTAG serial, a
    phone's serial/UDID, a host device node) with another unit served from the
    same HOST — across every catalog whose daemon runs there (amd-rig runs the
    SDR and PHONE daemons side by side) — so two concurrent reservations never
    drive the same hardware. This caught RISK-5: board 58:E6:C5:11:FC:D8 was
    bound in both amd-rig catalogs (catalog-sdr.json c6-1 and catalog-phone.json
    c6-a) until #235 moved the phone unit to the spare C6.
  * A special-purpose bench unit flagged ``pin_only`` is reachable ONLY by an
    explicit target (its unit name or type), never by a bare "any DUT with these
    caps" request — so an ordinary caps-only job (e.g. a netstack test asking for
    flash+improv+wss-app) can never land on, and thereby steal / disturb, the SDR
    bench's C6 or the emulator slot. The harness enforces this on BOTH selection
    paths (``hitl_client._unit_serves`` for free units, ``Reservation._unit_matches``
    for queue routing), exactly as the HITL CI lane relies on.

These bite if the isolation regresses: a shared component, a dropped ``pin_only``,
or a ``pin_only`` wrongly set on an everyday unit. See DESIGN.md "Multiple DUTs per
rig" / "Capability-based selection" and the catalog-sdr/-phone ``pin_only`` notes.
"""

import json
import os
import re
from pathlib import Path

import pytest
from hitl_client import Reservation, _unit_serves

pytestmark = pytest.mark.usefixtures("clean_hitl_env")
_PR24 = pytest.mark.requirements("PR-24")

_CATALOG_NAMES = ("catalog.json", "catalog-sdr.json", "catalog-phone.json", "catalog-mac.json")


def _repo_file(relpath):
    """Locate a workspace-relative file under Bazel runfiles or in a source checkout."""
    try:
        from python.runfiles import runfiles as _rf  # Bazel-provided

        r = _rf.Create()
        if r:
            p = r.Rlocation("_main/" + relpath)
            if p and Path(p).is_file():
                return Path(p)
    except Exception:  # noqa: BLE001 - offline (no runfiles): fall back to the source tree
        pass
    for base in Path(__file__).absolute().parents:
        cand = base / relpath
        if cand.is_file():
            return cand
    return None


def _load_catalogs():
    out = {}
    for name in _CATALOG_NAMES:
        p = _repo_file("pi/hitl/reserve/" + name)
        if p is None:
            # Under Bazel every catalog is test data: a missing one is a wiring bug,
            # not a reason to quietly check fewer catalogs.
            assert not os.environ.get(
                "TEST_SRCDIR"
            ), f"catalog {name!r} missing from the test's runfiles"
            continue
        out[name] = json.loads(p.read_text())
    return out


# Catalogs whose daemons run side by side on one host: pi/hitl/flake.nix gives
# amd-rig both nix/hitl-sdr.nix (catalog-sdr) and nix/hitl-phone-daemon.nix
# (catalog-phone). Every other catalog is its own host.
_CO_DEPLOYED = (
    ("amd-rig", ("catalog-sdr.json", "catalog-phone.json")),
    ("hitl-rig", ("catalog.json",)),
    ("mac", ("catalog-mac.json",)),
)

_BYID_RE = re.compile(r"usb-Espressif_USB_JTAG_serial_debug_unit_([0-9A-Fa-f:]+)-if00")
# env markers that name one physical device: a board's USB-JTAG serial, a phone's
# adb serial or iOS UDID.
_IDENTITY_ENV_RE = re.compile(r"^(HITL_ADAPTER_SERIAL(_\d+)?|HITL_ANDROID_SERIAL|HITL_IOS_UDID)$")


def _norm(s):
    return s.replace(":", "").replace("-", "").lower()


def _physical_ids(component):
    """What a component physically IS: board serials (by-id symlink + adapter env),
    phone serials/UDIDs, and the host side of every device node it mounts."""
    ids = set()
    for dev in component.get("devices") or []:
        host = dev.split(":/", 1)[0] if ":/" in dev else dev
        m = _BYID_RE.search(host)
        ids.add(f"board:{_norm(m.group(1))}" if m else f"node:{host}")
    for key, val in (component.get("env") or {}).items():
        if _IDENTITY_ENV_RE.match(key):
            ids.add(f"board:{_norm(val)}" if key.startswith("HITL_ADAPTER") else f"device:{val}")
    return ids


def test_co_deployed_catalogs_cover_every_listed_catalog():
    """The host grouping below names each listed catalog exactly once, so a new
    catalog can't silently escape the per-host isolation check."""
    grouped = [name for _, names in _CO_DEPLOYED for name in names]
    assert sorted(grouped) == sorted(_CATALOG_NAMES)


def _unit_caps(cat, unit):
    """What the daemon's /status would advertise for a unit: its explicit
    capabilities, else the union of its components' resource-type capabilities."""
    if unit.get("capabilities"):
        return set(unit["capabilities"])
    rtypes = cat.get("resource_types", {})
    comps = {c["name"]: c for c in cat.get("components", [])}
    caps = set()
    for name in unit.get("components", []):
        comp = comps.get(name, {})
        caps |= set(rtypes.get(comp.get("type"), {}).get("capabilities", []))
    return caps


def _unit_status(cat, unit):
    """A free-unit /status record as hitl_client's selection logic consumes it."""
    return {
        "name": unit["name"],
        "type": unit.get("type", ""),
        "capabilities": sorted(_unit_caps(cat, unit)),
        "pin_only": bool(unit.get("pin_only")),
        "active": None,  # free
    }


def _all_units():
    out = []
    for cat_name, cat in _load_catalogs().items():
        for unit in cat.get("units", []):
            out.append((cat_name, cat, unit))
    return out


@_PR24
def test_no_physical_device_is_shared_between_two_units_on_one_host():
    """Across every catalog served from one host, no two units reach the same
    physical device (by serial / UDID / host device node, not component name), so
    concurrent reservations of different units never drive the same hardware."""
    cats = _load_catalogs()
    checked = False
    for host, names in _CO_DEPLOYED:
        units = []  # (label, physical ids)
        for cat_name in names:
            cat = cats.get(cat_name)
            if cat is None:
                continue
            comps = {c["name"]: c for c in cat.get("components", [])}
            for unit in cat.get("units", []):
                ids = set()
                for comp_name in unit.get("components", []):
                    ids.add(f"component:{cat_name}:{comp_name}")  # same name, same catalog
                    ids |= _physical_ids(comps.get(comp_name, {}))
                units.append((f"{cat_name}:{unit['name']}", ids))
        for i in range(len(units)):
            for j in range(i + 1, len(units)):
                checked = True
                shared = units[i][1] & units[j][1]
                assert not shared, (
                    f"{host}: units {units[i][0]} and {units[j][0]} share "
                    f"{sorted(shared)} — concurrent reservations collide"
                )
    if not checked:
        pytest.skip("no host with two or more reservable units available")


def test_every_unit_component_reference_resolves_to_a_declared_component():
    """A unit's components all exist (catalog well-formedness; untraced)."""
    units = _all_units()
    if not units:
        pytest.skip("no catalog with explicit reservable units available")
    for cat_name, cat, unit in units:
        declared = {c["name"] for c in cat.get("components", [])}
        for name in unit.get("components", []):
            assert (
                name in declared
            ), f"{cat_name}:{unit['name']} references undeclared component {name!r}"


@_PR24
def test_pin_only_units_are_unreachable_by_a_caps_only_request():
    """A pin_only unit is refused by a bare caps-only request of its OWN capabilities
    on both selection paths, but reachable by its exact type — so an any-DUT job can
    never steal a special-purpose bench, while its own SDR/emulator reservations still
    land."""
    pin_units = [(n, c, u) for (n, c, u) in _all_units() if u.get("pin_only")]
    if not pin_units:
        pytest.skip("no pin_only unit in the available catalogs")
    for cat_name, cat, unit in pin_units:
        u = _unit_status(cat, unit)
        caps = list(u["capabilities"])
        assert caps, f"{cat_name}:{unit['name']} advertises no caps to test with"
        # Free-unit gate: a caps-only request must NOT serve a pin_only unit...
        assert (
            _unit_serves(u, "", caps) is False
        ), f"{cat_name}:{unit['name']} is pin_only yet a caps-only request serves it"
        # Queue-routing gate: same refusal.
        assert (
            Reservation(require_caps=caps)._unit_matches(u) is False
        ), f"{cat_name}:{unit['name']} is pin_only yet _unit_matches routes to it"
        # ...but an explicit by-TYPE request opts past pin_only and reaches it.
        assert (
            _unit_serves(u, u["type"], caps) is True
        ), f"{cat_name}:{unit['name']} refuses even its own explicit type {u['type']!r}"
        assert Reservation(sku=u["type"], require_caps=caps)._unit_matches(u) is True


@_PR24
def test_caps_only_requests_still_reach_an_everyday_unit():
    """A non-pin unit IS served by a caps-only request of its caps — so pin_only isn't
    wrongly stranding ordinary work (the inverse guard: the pin test above can't pass
    just because selection refuses everything)."""
    everyday = [
        (n, c, u) for (n, c, u) in _all_units() if not u.get("pin_only") and _unit_caps(c, u)
    ]
    if not everyday:
        pytest.skip("no non-pin unit with capabilities in the available catalogs")
    for cat_name, cat, unit in everyday:
        u = _unit_status(cat, unit)
        caps = list(u["capabilities"])
        assert (
            _unit_serves(u, "", caps) is True
        ), f"{cat_name}:{unit['name']} is not pin_only yet a caps-only request is refused"
        assert Reservation(require_caps=caps)._unit_matches(u) is True
