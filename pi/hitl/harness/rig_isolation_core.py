"""Pure verdict logic for the on-hardware rig-isolation probe.

Given a rig's ``/status`` unit list, decide whether the live daemon advertises its
USB DUTs by a STABLE PHYSICAL identity (a serial-derived ``c6-<serial>`` name, from
the board's USB-JTAG by-id symlink) and whether any two DUTs collide on that
identity. Kept here, free of any reservation/HTTP, so the verdict is unit-tested off
hardware (``tests/test_rig_isolation_core.py``) while the hitl wrapper
(``hitl_rig_isolation.py``) only does the reserve + ``/status`` fetch.

A discovered ESP board's name is ``<prefix><serial>`` where the serial is the board's
USB-JTAG serial (its MAC, separators stripped) — see DESIGN.md "Multiple DUTs per
rig". Two units sharing a serial (or one name listed twice, the realistic form: the
name is derived from the serial) would mean the daemon could flash/inspect the
wrong board. This is a sanity check of the daemon's advertised names only, not
PR-30 evidence: it never reads the board a reservation actually got.
"""

from __future__ import annotations

import re
from collections import Counter
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
    AssertionError naming the colliding units if two share a serial or a name.
    Counts over the RAW unit list, so a name listed twice (which the
    {name -> serial} map would silently merge) is caught too.
    """
    pairs = []  # (name, serial) for every serial-derived unit, duplicates kept
    for u in units:
        name = str(u.get("name", ""))
        m = _BOARD_NAME_RE.match(name)
        if m:
            pairs.append((name, m.group(1).lower()))
    for name, serial in pairs:
        assert serial, f"unit {name} has an empty board serial identity"
    dup_names = sorted(n for n, c in Counter(n for n, _ in pairs).items() if c > 1)
    if dup_names:
        raise AssertionError(
            f"unit name(s) {dup_names} listed more than once — the rig advertises one "
            "board identity for several DUTs"
        )
    by_serial = Counter(s for _, s in pairs)
    for serial, count in sorted(by_serial.items()):
        if count > 1:
            names = sorted(n for n, s in pairs if s == serial)
            raise AssertionError(
                f"units {names} share board identity {serial!r} "
                "— the rig cannot tell these DUTs apart by physical identity"
            )
    return dict(pairs)
