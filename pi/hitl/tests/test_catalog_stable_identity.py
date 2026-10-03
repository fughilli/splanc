"""PR-30 — isolate per-DUT USB/serial/debug by STABLE PHYSICAL identity.

The reservation catalogs (reserve/catalog*.json, baked into the rig images and
read by hitl-reserved) are the single source of truth for which physical board
each reservable DUT is. PR-30's protective property is that those bindings key on
a STABLE physical identity — the board's USB-JTAG serial, surfaced as a
``/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_<MAC>-if00`` symlink
— and NOT a boot-order ``/dev/ttyACM<n>`` slot (which the C6 renumbers on every
reset). So a multi-DUT run never flashes / resets / inspects the wrong board:

  * every ESP32 DUT that mounts a container serial device addresses it by the
    stable by-id symlink, never a bare ``/dev/ttyACM*`` / ``/dev/ttyUSB*``;
  * the adapter-serial the daemon injects for ``hitl-jtag``/``hitl-gdb`` to select
    the board's USB-JTAG equals the serial embedded in that same by-id symlink —
    so JTAG and the serial tty address the SAME physical board;
  * in a multi-C6 unit (the amd-rig SDR bench), the per-DUT env keys follow the
    ``--dut N`` suffix convention (``HITL_ADAPTER_SERIAL`` / ``_1`` / …) and map to
    distinct ttys, so ``--dut 1`` can never resolve DUT 0's board (the FUG-174
    regression this guards);
  * no two DUTs served from one HOST share a physical identity — compared across
    every catalog whose daemon runs there (amd-rig runs the SDR and PHONE
    daemons side by side). KNOWN GAP (RISK-5): board 58:E6:C5:11:FC:D8 is bound
    in both amd-rig catalogs, so that case is a strict xfail until the rig config
    is fixed;
  * USB auto-discovery keys on the stable by-id glob + per-MAC chip overrides,
    not a port slot.

Pure config inspection: these all FAIL if the protective keying regresses. See
DESIGN.md "Multiple DUTs per rig" / "Raw-USB isolation (FUG-73)" and commits
caef056a, dd7943f6, b5ac04ef.
"""

import json
import os
import re
from pathlib import Path

import pytest

_PR30 = pytest.mark.requirements("PR-30")

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


# usb-Espressif_USB_JTAG_serial_debug_unit_<MAC>-if00  (the stable by-id symlink)
_BYID_RE = re.compile(r"usb-Espressif_USB_JTAG_serial_debug_unit_([0-9A-Fa-f:]+)-if00")
_ADAPTER_KEY_RE = re.compile(r"^HITL_ADAPTER_SERIAL(_\d+)?$")
_TTY_KEY_RE = re.compile(r"^HITL_TTY(_\d+)?$")
_MAC_RE = re.compile(r"^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
_BOOT_ORDER_DEV_RE = re.compile(r"^/dev/tty(ACM|USB)\d+$")


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


def _norm_serial(s):
    return s.replace(":", "").replace("-", "").lower()


def _is_esp(component):
    return str(component.get("type", "")).startswith("esp32")


def _host_side(dev):
    """The HOST side of a "host:container" device mapping (or the whole string)."""
    # Only split on a ':' that separates the two paths, i.e. a ':/': a by-id name
    # itself contains ':'-separated MAC octets, so a naive split(":",1) is wrong.
    if ":/" in dev:
        return dev.split(":/", 1)[0]
    return dev


def _adapter_serial(component):
    env = component.get("env") or {}
    for k, v in env.items():
        if _ADAPTER_KEY_RE.match(k):
            return v
    return None


def _board_serials(component):
    """Every normalized USB-JTAG serial a component is bound to: its by-id serial
    symlinks plus every HITL_ADAPTER_SERIAL[_k] it injects."""
    ids = {
        _norm_serial(m.group(1))
        for dev in component.get("devices") or []
        if (m := _BYID_RE.search(_host_side(dev)))
    }
    for k, v in (component.get("env") or {}).items():
        if _ADAPTER_KEY_RE.match(k):
            ids.add(_norm_serial(v))
    return ids


def _esp_components_with_devices():
    """(catalog, component) for every ESP32 DUT that mounts a container serial
    device — the ones the container reaches over /dev/ttyACM0 + libusb."""
    out = []
    for name, cat in _load_catalogs().items():
        for comp in cat.get("components", []):
            if _is_esp(comp) and comp.get("devices"):
                out.append((name, comp))
    return out


@_PR30
def test_esp_duts_address_boards_by_stable_byid_symlink():
    """Each ESP32 DUT's container serial device is a /dev/serial/by-id/ symlink
    (stable across the C6's per-reset re-enumeration), never a boot-order ttyACMn."""
    items = _esp_components_with_devices()
    if not items:
        pytest.skip("no catalog with explicit ESP32 device mounts available")
    for cat_name, comp in items:
        for dev in comp["devices"]:
            host = _host_side(dev)
            assert host.startswith(
                "/dev/serial/by-id/"
            ), f"{cat_name}:{comp['name']} binds {host!r} — not a stable by-id symlink"
            assert not _BOOT_ORDER_DEV_RE.match(
                host
            ), f"{cat_name}:{comp['name']} keys on boot-order {host!r} (renumbers on reset)"
            assert _BYID_RE.search(
                host
            ), f"{cat_name}:{comp['name']} by-id path carries no USB-JTAG serial: {host!r}"


@_PR30
def test_jtag_adapter_serial_matches_the_serial_ttys_board():
    """The adapter serial the daemon injects (for hitl-jtag/gdb to pick the board's
    USB-JTAG) equals the serial embedded in the SAME DUT's by-id serial-tty symlink
    — so JTAG and the serial console address one physical board, never two."""
    items = _esp_components_with_devices()
    if not items:
        pytest.skip("no catalog with explicit ESP32 device mounts available")
    for cat_name, comp in items:
        byid_serials = {
            _norm_serial(m.group(1))
            for dev in comp["devices"]
            if (m := _BYID_RE.search(_host_side(dev)))
        }
        assert byid_serials, f"{cat_name}:{comp['name']} has no by-id serial to key on"
        adapter = _adapter_serial(comp)
        assert adapter is not None, (
            f"{cat_name}:{comp['name']} mounts a board but declares no HITL_ADAPTER_SERIAL — "
            "hitl-jtag/gdb cannot select it among identical boards"
        )
        assert _norm_serial(adapter) in byid_serials, (
            f"{cat_name}:{comp['name']} adapter serial {adapter!r} does not match its "
            f"serial-tty board {sorted(byid_serials)} — JTAG would target a different board"
        )


@_PR30
def test_multi_dut_env_keys_follow_the_per_dut_suffix_convention():
    """In a composite unit, the k-th ESP32 DUT (0-based, in listed order) carries the
    `_k`-suffixed env keys (HITL_ADAPTER_SERIAL[_k] / HITL_TTY[_k]) and a distinct tty,
    so `--dut N` resolves a UNIQUE board. Guards the FUG-174 collision (a second C6
    left on the unsuffixed key would shadow DUT 0)."""
    cats = _load_catalogs()
    checked_multi = False
    for cat_name, cat in cats.items():
        comps = {c["name"]: c for c in cat.get("components", [])}
        for unit in cat.get("units", []):
            esp = [comps[n] for n in unit.get("components", []) if n in comps and _is_esp(comps[n])]
            if len(esp) >= 2:
                checked_multi = True
            adapter_serials, host_ttys, cont_ttys = [], [], []
            for k, comp in enumerate(esp):
                suffix = "" if k == 0 else f"_{k}"
                env = comp.get("env") or {}
                want = f"HITL_ADAPTER_SERIAL{suffix}"
                assert want in env, (
                    f"{cat_name}:{unit['name']} DUT {k} ({comp['name']}) lacks {want!r}; "
                    f"has {[k2 for k2 in env if _ADAPTER_KEY_RE.match(k2)]} — `--dut {k}` "
                    "would resolve the wrong board"
                )
                adapter_serials.append(_norm_serial(env[want]))
                for key, val in env.items():
                    if _TTY_KEY_RE.match(key):
                        host_ttys.append(val)
                for dev in comp.get("devices") or []:
                    if ":/" in dev:
                        cont_ttys.append(dev.split(":/", 1)[1])
            # Distinct physical identity + distinct device nodes across the unit's DUTs.
            assert len(adapter_serials) == len(
                set(adapter_serials)
            ), f"{cat_name}:{unit['name']} DUTs share an adapter serial {adapter_serials}"
            assert len(cont_ttys) == len(
                set(cont_ttys)
            ), f"{cat_name}:{unit['name']} DUTs share a container tty {cont_ttys}"
    if not checked_multi:
        pytest.skip("no multi-ESP32 composite unit in the available catalogs")


@_PR30
@pytest.mark.xfail(
    strict=True,
    reason=(
        "RISK-5 known gap: board 58:E6:C5:11:FC:D8 is bound in both amd-rig catalogs "
        "(catalog-sdr.json c6-1 and catalog-phone.json c6-a), so the SDR and phone "
        "daemons can each hand it out. A rig config fix makes this pass; then drop "
        "the xfail."
    ),
)
def test_no_two_duts_on_one_host_share_a_physical_identity():
    """Across every catalog served from one host, no two ESP32 DUTs share a USB-JTAG
    serial (by-id or adapter): distinct physical boards, so reserving one never
    reaches another's silicon, whichever daemon hands it out."""
    cats = _load_catalogs()
    checked = False
    for host, names in _CO_DEPLOYED:
        owners = {}  # serial -> "catalog:component"
        for cat_name in names:
            cat = cats.get(cat_name)
            if cat is None:
                continue
            for comp in cat.get("components", []):
                if not _is_esp(comp):
                    continue
                label = f"{cat_name}:{comp['name']}"
                for s in _board_serials(comp):
                    checked = True
                    assert s not in owners, f"{host}: {label} and {owners[s]} both claim board {s}"
                    owners[s] = label
    if not checked:
        pytest.skip("no catalog with explicit ESP32 physical identities available")


def test_co_deployed_catalogs_cover_every_listed_catalog():
    """The host grouping above names each listed catalog exactly once, so a new
    catalog can't silently escape the per-host identity check."""
    grouped = [name for _, names in _CO_DEPLOYED for name in names]
    assert sorted(grouped) == sorted(_CATALOG_NAMES)


@_PR30
def test_usb_discovery_keys_on_stable_byid_identity_not_a_port_slot():
    """Auto-discovery enumerates boards by the stable by-id serial glob and keys its
    chip overrides by MAC (physical identity) — never a boot-order port slot."""
    cats = _load_catalogs()
    checked = False
    for cat_name, cat in cats.items():
        disc = cat.get("discovery")
        if not disc or not disc.get("enabled"):
            continue
        checked = True
        glob = disc.get("glob", "")
        assert glob.startswith(
            "/dev/serial/by-id/"
        ), f"{cat_name}: discovery glob {glob!r} is not a stable by-id path"
        assert (
            "USB_JTAG_serial_debug_unit_" in glob
        ), f"{cat_name}: discovery glob {glob!r} does not match on the board serial"
        assert disc.get("name_prefix"), f"{cat_name}: discovery has no serial-derived name_prefix"
        for mac in disc.get("chip_overrides") or {}:
            assert _MAC_RE.match(
                mac
            ), f"{cat_name}: chip override key {mac!r} is not a board MAC (physical identity)"
    if not checked:
        pytest.skip("no catalog with USB auto-discovery available")
