"""Layout-guard scenarios: the connect flow (D-72) and its way forward (D-219).

The welcome screen and the device drawer, connected and not, with fixtures
heard on the network and a known one that isn't (docs/ux/oobe-review.md,
requests for #577). Everything runs on the app's `?demo=` seams (a fake
connected "Living Room", `discovered` mDNS adverts, a `stale` known fixture),
so nothing reaches the network.
"""

from __future__ import annotations

from layout_guard import Scenario

# Open the device drawer from the Device tab.
DRAWER = [
    ("wait_for", ".tab[data-tab=device]", 15000),
    ("click", ".tab[data-tab=device]"),
    ("wait", 600),
]

SCENARIOS = [
    # Fresh install, nothing connected: Connect a fixture leads.
    Scenario("connect-0-welcome", "#/onboard", steps=[("wait_for", ".onboard-cta button", 15000)]),
    # Welcome once a fixture is connected: the CTA reads "Choose an effect".
    Scenario(
        "connect-1-welcome-connected",
        "#/onboard",
        search="?demo=device",
        steps=[("wait_for", ".onboard-cta button", 15000)],
        expect=".onboard-cta .k-btn",
    ),
    # The drawer: a connected fixture (Choose an effect), a known one at a new
    # address, and two new ones on the network.
    Scenario(
        "connect-2-drawer",
        "#/maps",
        search="?demo=device,discovered",
        steps=DRAWER,
        root=".k-sheet",
        expect=".device-next",
    ),
    # ...plus a known fixture that isn't on this network: what to do about it.
    Scenario(
        "connect-3-drawer-stale",
        "#/maps",
        search="?demo=device,discovered,stale",
        steps=DRAWER,
        root=".k-sheet",
        expect=".device-stale",
    ),
    # Nothing connected: the drawer with only heard + stale fixtures.
    Scenario(
        "connect-4-drawer-offline",
        "#/maps",
        search="?demo=discovered,stale",
        steps=DRAWER,
        root=".k-sheet",
        expect=".device-stale",
    ),
    # The picker itself.
    Scenario(
        "connect-5-picker",
        "#/onboard",
        steps=[
            ("wait_for", ".connect-primary", 15000),
            ("click", ".connect-primary"),
            ("wait", 600),
        ],
        root=".k-sheet",
        expect=".connect-modes",
    ),
]
