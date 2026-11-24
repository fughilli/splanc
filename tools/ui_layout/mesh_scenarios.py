"""Layout-guard scenarios: the "Create a mesh" flow (mesh M7 app UI).

No demo mode: the app boots with four saved fixtures seeded into localStorage (the
known-devices store) and no network (the guard blocks everything off-origin). The steps
that need no fixture are driven for real (intro, pick, name); "Create mesh" then really
runs: the app makes its WebCrypto admin key, tries each fixture over wss, and lands on the
"some fixtures didn't join" step with its retry, which is what a phone off the fixtures'
network sees. The joined states and the device sheet's Mesh section need a live mesh
fixture: they are unit-tested (web/tests/meshAdmin.test.ts) and checked on real lamps.

The mesh map (#/mesh/topology) runs on the app's `?demo=device,meshtopo` seam: a connected
"Living Room" gateway with four others (two placed in the room, one unplaced two hops out,
one on older firmware), its node sheet opened from the fixture list, and the "Hops" link
colouring.
"""

from __future__ import annotations

import json

from layout_guard import Scenario

LAMPS = [
    ("wss://living-room.local:8443/ws", "Living Room"),
    ("wss://desk-lamp.local:8443/ws", "Desk Lamp"),
    ("wss://hall-lamp.local:8443/ws", "Hall Lamp"),
    ("wss://bedroom-lamp.local:8443/ws", "Bedroom Lamp"),
]


def _dev(url: str, label: str) -> dict:
    return {
        "id": "dev-" + "".join(c if c.isalnum() else "-" for c in url).replace("--", "-"),
        "wssUrl": url,
        "label": label,
        "bleMac": "",
        "named": True,
        "lastSeen": "2026-11-21T20:00:00Z",
    }


SEED = {"ledmapper.devices": json.dumps([_dev(u, n) for u, n in LAMPS])}


def title(text: str) -> str:
    return f'.cf-title:has-text("{text}")'


def btn(text: str) -> str:
    return f'button:has-text("{text}")'


TO_PICKED = [("click", btn("Get started")), ("wait_for", title("Which fixtures?"))] + [
    ("check", f".mf-pick-row:has-text('{n}') input") for _, n in LAMPS
]
TO_NAME = TO_PICKED + [("click", btn("Continue")), ("wait_for", title("Name your mesh"))]
TO_UNREACHABLE = TO_NAME + [
    ("click", btn("Create mesh")),
    ("wait_for", title("Some fixtures didn't join"), 90000),
]

SCENARIOS = [
    Scenario("mesh-01-intro", "#/mesh/new", seed=SEED, expect=btn("Get started")),
    Scenario(
        "mesh-02-pick", "#/mesh/new", seed=SEED, steps=TO_PICKED, expect=title("Which fixtures?")
    ),
    Scenario(
        "mesh-03-name", "#/mesh/new", seed=SEED, steps=TO_NAME, expect=title("Name your mesh")
    ),
    Scenario(
        "mesh-04-unreachable",
        "#/mesh/new",
        seed=SEED,
        steps=TO_UNREACHABLE,
        expect=btn("Try the failed ones again"),
    ),
]

# The mesh map (#/mesh/topology) on the demo mesh.
TOPO = [("wait_for", ".mtopo-member", 15000), ("wait", 400)]
SCENARIOS += [
    Scenario(
        "mesh-10-topology",
        "#/mesh/topology",
        search="?demo=device,meshtopo",
        steps=TOPO,
        expect=".mesh-topo-view",
    ),
    Scenario(
        "mesh-11-topology-hops",
        "#/mesh/topology",
        search="?demo=device,meshtopo",
        steps=TOPO + [("click", '.mtopo-seg button[data-colouring="hops"]'), ("wait", 300)],
        expect='.mtopo-seg button.on[data-colouring="hops"]',
    ),
    Scenario(
        "mesh-12-topology-node",
        "#/mesh/topology",
        search="?demo=device,meshtopo",
        steps=TOPO + [("click", '.mtopo-member[data-node="21191"]'), ("wait", 500)],
        root=".k-sheet",
        expect=".mtopo-sheet",
    ),
    # The device sheet's Mesh section with its way into the map.
    Scenario(
        "mesh-13-section-map-entry",
        "#/maps",
        search="?demo=device,meshtopo",
        steps=[
            ("wait_for", ".tab[data-tab=device]", 15000),
            ("click", ".tab[data-tab=device]"),
            ("wait_for", ".k-sheet button[title=Options]", 15000),
            ("click", ".k-sheet button[title=Options]"),
            ("wait_for", 'button:has-text("Show the mesh map")', 15000),
        ],
        # The detail sheet only (the device list sheet stays open under it).
        root=".k-sheet:has(.mesh-section)",
        expect='button:has-text("Show the mesh map")',
    ),
]
