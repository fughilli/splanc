"""BLE player-link budget + reporting shared by the BLE player gates (runner side, pure).

The rig-side driver (hitl_ble_player.py) rides out up to `MAX_LINK_LOSSES` dropped BLE
links per exchange the way the app's LedMapperClient does over BLE: reconnect, hello,
resend the in-flight request (a drop mid map-push restarts the push from window 0).

Why a budget at all (measured on CI 2026-11-12..20, 115 ble_capture_e2e_netstack attempts): on
hitl-rig-2 the central drops a connected link (DUT serial `[ble] link ... disc=0x08`,
supervision timeout) about once per 40 s of connection, on all five of its DUTs and in
every BLE test, with the same firmware that rarely drops on rig-1 — ble_capture's 40 s
sequence lost the link in 26 of 58 rig-2 attempts vs 1 of 57 on rig-1, and Improv
provisioning lost it in 52 of 1217 rig-2 provisions vs 0 of 910 on rig-1. A phone's
link drops too, and the app reconnects; the gate now does the same and REPORTS each
drop, so a firmware change that starts dropping links still fails (more drops than the
budget) and the rig's drop rate stays on record instead of failing unrelated PRs.
"""

from __future__ import annotations

MAX_LINK_LOSSES = 3


def link_loss_summary(losses: list[dict], tag: str = "ble-capture") -> str:
    """One parseable line recording the BLE link drops an exchange rode out."""
    if not losses:
        return f"[{tag}] link losses: 0"
    detail = "; ".join(f"frame {x.get('frame')} @{x.get('t_s')}s: {x.get('error')}" for x in losses)
    return f"[{tag}] link losses: {len(losses)} ({detail})"
