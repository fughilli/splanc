"""Board-capabilities contract for the HITL board-caps check (FUG-123).

The firmware embeds a BoardCapabilities descriptor (compiled from
firmware/player_app/board_caps.textproto) and reports it over the player
WebSocket in hardware_config_state.board. This module loads that SAME textproto
as the EXPECTED value and diffs it against what a device actually reports, so the
on-hardware test (hitl_e2e.py, BOARD CAPS phase) proves the whole
embed -> FFI decode -> RPC round-trip on real hardware WITHOUT duplicating the
pin catalog here — the checked-in textproto is the single source of truth.

Pure (parse + diff, no hardware / no network); unit-tested off hardware in
//pi/hitl/tests (test_board_caps.py). The reported dict is exactly what
server.proto_wire.decode_server produces (camelCase fields, enums as their name
strings, no-presence fields always emitted), so `parse_expected` renders the
textproto through the identical json_format options.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from google.protobuf import json_format, text_format
from ledmapper_pb2 import BoardCapabilities


def parse_expected(textproto: str) -> Dict[str, Any]:
    """Parse a BoardCapabilities textproto into the same dict shape
    proto_wire.decode_server produces for the reported `board` (camelCase names,
    enums as name strings, no-presence fields always emitted)."""
    msg = BoardCapabilities()
    text_format.Merge(textproto, msg)
    return json_format.MessageToDict(
        msg,
        preserving_proto_field_name=False,
        always_print_fields_with_no_presence=True,
    )


def _canon(caps: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a board-caps dict (expected or reported) for comparison: pins
    keyed by gpio with defaults filled, so a comparison is order-independent and
    robust to whichever json_format options produced the dict."""
    pins: Dict[int, Dict[str, str]] = {}
    for p in caps.get("gpioPins", []):
        pins[int(p.get("gpio", 0))] = {
            "safety": p.get("safety", "PIN_SAFETY_UNSPECIFIED"),
            "note": p.get("note", ""),
        }
    modes = [(m.get("id", ""), m.get("label", "")) for m in caps.get("ledModes", [])]
    return {"board": caps.get("board", ""), "pins": pins, "modes": modes}


def diff_board_caps(expected: Dict[str, Any], reported: Optional[Dict[str, Any]]) -> List[str]:
    """Human-readable mismatches between the expected board caps and what the
    device reported. Empty list == the device reports EXACTLY the descriptor."""
    if not reported:
        return ["device reported no board capabilities (hardware_config_state.board unset)"]
    exp, got = _canon(expected), _canon(reported)
    diffs: List[str] = []
    if exp["board"] != got["board"]:
        diffs.append(f"board name: expected {exp['board']!r}, got {got['board']!r}")
    exp_pins, got_pins = exp["pins"], got["pins"]
    for gpio in sorted(set(exp_pins) | set(got_pins)):
        e, g = exp_pins.get(gpio), got_pins.get(gpio)
        if e is None:
            diffs.append(f"GPIO {gpio}: device reports it but the descriptor doesn't")
        elif g is None:
            diffs.append(f"GPIO {gpio}: in the descriptor but the device didn't report it")
        elif e != g:
            diffs.append(f"GPIO {gpio}: expected {e}, got {g}")
    if exp["modes"] != got["modes"]:
        diffs.append(f"LED modes: expected {exp['modes']}, got {got['modes']}")
    return diffs
