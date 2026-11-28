"""Layout-guard scenarios: "Set up a bridge" (#698, #/bridge/setup).

Every step and failure of the flow, on `?demo=bridge-<variant>`: a scripted bridge
behind the flow's I/O seam (web/src/demo/bridgeSetupDemo.ts) with a stand-in
Bluetooth chooser, so nothing reaches a radio, the LAN or the relay.
"""

from __future__ import annotations

import json

from layout_guard import Scenario

ROUTE = "#/bridge/setup"
START = ("wait_for", ".cf-title", 15000)
PRIMARY = ".cf-actions .k-btn:not(.k-btn--quiet)"
GET_STARTED = [START, ("click", PRIMARY), ("wait_for", ".bs-hint")]
# The done pages run past a phone's fold: bring the action row into view so the
# guard checks it (it only measures what is on screen).
SHOW_ACTIONS = ("hover", ".cf-actions .k-btn--quiet")
SEND_WIFI = [
    *GET_STARTED,
    ("fill", ".cf-field input[type=text]", "Home Wi-Fi"),
    ("fill", ".k-pw input", "correct horse"),
    ("click", PRIMARY),
]

# This app is already paired with the demo bridge (Live via bridge's credential).
PAIRED_SEED = {
    "splanc.bridge.v1": json.dumps(
        {
            "relay": "https://splanc.pages.dev",
            "token": "spl_pt_demo",
            "clientId": "demo",
            "name": "Splanc app (iPhone)",
            "lan": {
                "url": "wss://192.168.1.40:8443/live",
                "page": "https://192.168.1.40:8443/",
                "sha256": "5f3c9a0e7d21b84c6a1e0f9b3d7c2a58e4b1f60d9c8a7e3b2d1f0c9e8a7b6c5d",
            },
        }
    )
}


def demo(variant: str) -> str:
    return f"?demo=bridge-{variant}"


def failed(sid: str, variant: str, expect: str = ".bs-stages") -> Scenario:
    return Scenario(
        sid,
        ROUTE,
        search=demo(variant),
        steps=[*SEND_WIFI, ("wait_for", ".cf-hero--warn", 15000)],
        expect=expect,
    )


SCENARIOS = [
    Scenario("bridge-00-intro", ROUTE, search=demo("fresh"), steps=[START], expect=".cf-facts"),
    Scenario(
        "bridge-01-wifi",
        ROUTE,
        search=demo("fresh"),
        steps=GET_STARTED,
        expect=".wifi-cap, .bs-hint",
    ),
    Scenario(
        "bridge-02-joining",
        ROUTE,
        search=demo("joining"),
        steps=[*SEND_WIFI, ("wait_for", ".bs-stage--active[data-stage=wifi]")],
        expect=".bs-status",
    ),
    Scenario(
        "bridge-03-checking",
        ROUTE,
        search=demo("slow"),
        steps=[*SEND_WIFI, ("wait_for", ".bs-stage--active[data-stage=relay]", 15000)],
        expect=".bs-stage--ok[data-stage=agent]",
    ),
    Scenario(
        "bridge-04-pair",
        ROUTE,
        search=demo("fresh"),
        steps=[*SEND_WIFI, ("wait_for", ".cf-code", 15000)],
        expect=".bs-hint",
    ),
    Scenario(
        "bridge-05-paired",
        ROUTE,
        search=demo("fresh"),
        steps=[
            *SEND_WIFI,
            ("wait_for", ".cf-code", 15000),
            ("fill", ".cf-code", "ABCD-EFGH"),
            ("click", PRIMARY),
            ("wait_for", ".bs-players", 15000),
            SHOW_ACTIONS,
        ],
        expect=".bs-players",
    ),
    Scenario(
        "bridge-06-moved",
        ROUTE,
        search=demo("moved"),
        seed=PAIRED_SEED,
        steps=[*SEND_WIFI, ("wait_for", ".bs-players", 15000), SHOW_ACTIONS],
        expect=".bs-players",
    ),
    Scenario(
        "bridge-07-browser-pair",
        ROUTE,
        search=demo("browser"),
        steps=[*SEND_WIFI, ("wait_for", ".cf-code", 15000)],
        expect=".bs-stage--later",
    ),
    Scenario(
        "bridge-08-handoff",
        ROUTE,
        search=demo("handoff"),
        steps=[("wait_for", ".cf-code", 15000)],
        expect=".bs-stage--ok[data-stage=wifi]",
    ),
    failed("bridge-09-fail-wrongpw", "wrongpw"),
    failed("bridge-10-fail-unreachable", "unreachable"),
    failed("bridge-11-fail-relayblocked", "relayblocked"),
    failed("bridge-12-fail-notbridge", "notbridge", expect=".cf-lead"),
    # Live via bridge, not paired: the way into the flow.
    Scenario(
        "bridge-13-live-entry",
        "#/bridge",
        steps=[("wait_for", ".bridge-setup-link", 15000)],
        expect=".bridge-setup-link",
    ),
]
