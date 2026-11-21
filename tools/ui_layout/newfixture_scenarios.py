"""Layout-guard scenarios: the new-fixture setup flow (D-259).

`?demo=device,newfixture` gives a connected controller with two uncounted
outputs that accepts the flow's probes and config nudges, so the flow can be
walked step by step with no hardware or network.
"""

from __future__ import annotations

from layout_guard import Scenario

DEMO = "?demo=device,newfixture"
START = ("wait_for", ".nf-title", 15000)
NEXT = ("click", ".nf-actions .k-btn:not(.k-btn--quiet)")

SCENARIOS = [
    Scenario("newfixture-1-name", "#/new-fixture", search=DEMO, steps=[START], expect=".nf-field"),
    Scenario(
        "newfixture-2-leds",
        "#/new-fixture",
        search=DEMO,
        steps=[START, NEXT, ("wait_for", ".nf-port")],
        expect=".nf-stepper",
    ),
    Scenario(
        "newfixture-3-order",
        "#/new-fixture",
        search=DEMO,
        steps=[START, NEXT, ("wait_for", ".nf-port"), NEXT, ("wait_for", ".nf-order")],
        expect=".nf-orders",
    ),
    Scenario(
        "newfixture-4-confirm",
        "#/new-fixture",
        search=DEMO,
        steps=[
            START,
            NEXT,
            ("wait_for", ".nf-port"),
            NEXT,
            ("wait_for", ".nf-order"),
            ("click", ".nf-order"),
            ("wait", 300),
        ],
        expect=".nf-dots",
    ),
    Scenario(
        "newfixture-5-done",
        "#/new-fixture",
        search=DEMO,
        steps=[
            START,
            NEXT,
            ("wait_for", ".nf-port"),
            NEXT,
            ("wait_for", ".nf-order"),
            ("click", ".nf-order"),
            ("wait", 300),
            NEXT,
            ("wait", 400),
        ],
        expect=".nf-actions",
    ),
]
