"""Layout-guard scenarios: the effect editor (a new effect, as the effects browser's
"New effect" opens it). Its docked panes carry small header controls (Move pane, Hide
pane) next to their tabs; the mesh_app_e2e HITL's shots found them flush. Checked per
region (the pane strips, the toolbar): the dense dock itself (a strip directly on its
pane's content) is the editor's design, not a crammed row.

The static app has no effect-compiler wasm here, so the editor shows its "couldn't
download the effect compiler" banner; the panes, tabs and toolbar render all the same.
"""

from __future__ import annotations

from layout_guard import Scenario

TO_EDITOR = [
    ("click", "[aria-label='New effect']"),
    ("wait_for", "textarea.fxedit-code", 15000),
    ("wait", 800),
]

SCENARIOS = [
    # Every dock's tab strip and pane header: the tabs (one joined control) and the Move /
    # Hide pane buttons, and the strips beside each other across a divider.
    Scenario(
        "editor-01-pane-controls",
        "#/effects",
        steps=TO_EDITOR,
        root=".fxlayout-edgetabs, .fxlayout-tabs, .fxpane-head",
        expect="textarea.fxedit-code",
    ),
    # The floating toolbar: Back, the name, the editor menu and collapse.
    Scenario(
        "editor-02-toolbar",
        "#/effects",
        steps=TO_EDITOR,
        root=".fxedit-drawer",
        expect="textarea.fxedit-code",
    ),
]
