"""Layout-guard scenarios: the out-of-box path (docs/ux/oobe-review.md).

Open the app → connect a fixture → pick an effect → tune it. The connected
states use the app's `?demo=device` seam (a fake "Living Room" controller, no
socket) plus `fxstub` (compiles answered from the declared uniforms: the static
server has no compiler wasm), so nothing reaches the network.
"""

from __future__ import annotations

from layout_guard import Scenario

# A device the app has seen before (returning user), connected.
KNOWN = "?demo=device,fxstub"
# The library renders after the first-run seeding; wait for it.
LIST = ("wait_for", ".map-row", 15000)

SCENARIOS = [
    # Fresh install: the welcome screen.
    Scenario("oobe-0-welcome", "#/onboard", steps=[("wait_for", ".onboard-cta button", 15000)]),
    # Effects, nothing connected: the "Connect your lights" card leads.
    Scenario("oobe-1-effects-offline", "#/effects", steps=[LIST], expect=".maps-list"),
    # Effects with a connected fixture: the fixture card + the menu.
    Scenario(
        "oobe-2-effects-connected", "#/effects", search=KNOWN, steps=[LIST], expect=".maps-list"
    ),
    # Tap a starter: it plays on the fixture and the tune sheet opens.
    Scenario(
        "oobe-3-tune",
        "#/effects",
        search=KNOWN,
        steps=[LIST, ("click", ".map-row"), ("wait", 1500)],
        settle_ms=1200,
        root=".k-sheet",
        expect=".fxtune-adjust",
    ),
    # Tap a starter with nothing connected: the sheet says so + Connect.
    Scenario(
        "oobe-3b-tune-offline",
        "#/effects",
        steps=[LIST, ("click", ".map-row"), ("wait", 800)],
        root=".k-sheet",
    ),
    # A returning user opens the app (no hash, like the installed start_url):
    # home, not "Set up your device".
    Scenario("oobe-4-home", "", search=KNOWN, steps=[LIST], expect=".fxhome-card"),
    # (The device drawer is #577's; its layout is checked there.)
    # The maps library (the old landing screen).
    Scenario("oobe-6-maps", "#/maps", search=KNOWN, steps=[LIST]),
]
