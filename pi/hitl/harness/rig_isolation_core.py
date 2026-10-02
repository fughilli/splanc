"""Pure verdict logic for the on-hardware rig-isolation probe (PR-30).

Given a rig's ``/status`` unit list, decide whether the live daemon advertises its
USB DUTs by a STABLE PHYSICAL identity (a serial-derived ``c6-<serial>`` name, from
the board's USB-JTAG by-id symlink) and whether any two DUTs collide on that
identity. Kept here, free of any reservation/HTTP, so the verdict is unit-tested off
hardware (``tests/test_rig_isolation_core.py``) while the hitl wrapper
(``hitl_rig_isolation.py``) only does the reserve + ``/status`` fetch.

A discovered ESP board's name is ``<prefix><serial>`` where the serial is the board's
USB-JTAG serial (its MAC, separators stripped) — see DESIGN.md "Multiple DUTs per
rig". A boot-order slot name (``dut0``) or two units sharing a serial would mean the
daemon could flash/inspect the wrong board, which PR-30 forbids.
"""

from __future__ import annotations

import re
from typing import Any

# c6-071234 / c3-ab12ef… : a chip-family prefix then the board serial (hex, >=4 nybbles).
_BOARD_NAME_RE = re.compile(r"^c\d+-([0-9a-fA-F]{4,})$")


def board_identities(units: list[dict[str, Any]]) -> dict[str, str]:
    """{unit name -> its physical serial identity} for every USB-board unit whose
    name is serial-derived. Empty if the rig advertises no such units (then the
    caller should SKIP — this rig's layout can't be evaluated for PR-30)."""
    out: dict[str, str] = {}
    for u in units:
        name = str(u.get("name", ""))
        m = _BOARD_NAME_RE.match(name)
        if m:
            out[name] = m.group(1).lower()
    return out


def check_distinct_board_identities(units: list[dict[str, Any]]) -> dict[str, str]:
    """Assert no two USB-board units share a physical serial identity.

    Returns the {name -> serial} map (empty => nothing to evaluate). Raises
    AssertionError naming the colliding units if two share a serial — the live
    form of "a multi-DUT run could flash/reset/inspect the wrong board".
    """
    ids = board_identities(units)
    seen: dict[str, str] = {}
    for name, serial in sorted(ids.items()):
        assert serial, f"unit {name} has an empty board serial identity"
        if serial in seen:
            raise AssertionError(
                f"units {seen[serial]!r} and {name!r} share board identity {serial!r} "
                "— the rig cannot tell these DUTs apart by physical identity"
            )
        seen[serial] = name
    return ids
