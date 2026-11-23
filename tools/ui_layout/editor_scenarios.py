"""Layout-guard scenarios: the effect editor (a new effect, as the effects browser's
"New effect" opens it). Its docked panes carry small header controls (Move pane, Hide
pane) next to their tabs; the mesh_app_e2e HITL's shots found them flush. Checked per
region (the pane strips, the toolbar): the dense dock itself (a strip directly on its
pane's content) is the editor's design, not a crammed row.

The guard serves the app with its wasm bundles (//web:ios_payload), so the editor compiles:
the uniforms pane is checked with an effect that declares one uniform of every kind the
panel draws (sliders, a colour, a ranged vector, a dropdown, a toggle, a mat3 grid).
"""

from __future__ import annotations

from layout_guard import Scenario

TO_EDITOR = [
    ("click", "[aria-label='New effect']"),
    ("wait_for", "textarea.fxedit-code", 15000),
    ("wait", 800),
]

# One uniform of every kind the panel draws (effects/editor/uniform-panel.ts).
UNIFORMS_FX = """\
uniform float speed  : 0.0 .. 2.0 = 0.4;
uniform float rate   : 0.0 .. 4.0 = 1.2;
uniform float width  : 0.05 .. 0.5 = 0.3;
uniform vec3  tint   : color = 0.2, 0.4, 0.9;
uniform vec2  offset : -1.0 .. 1.0 = 0.0, 0.5;
uniform int   mode   : {"wave","pulse","flat"} = 0;
uniform bool  invert = false;
uniform mat3  rot    : -1 .. 1 = mat3(1.0);

vec3 shade(Led led) {
  vec3 p = rot * led.pos;
  float t = fract(p.x * width + offset.x + offset.y + time * speed * rate);
  if (mode == 1) { t = t * t; }
  if (invert) { t = 1.0 - t; }
  return tint * t;
}
"""

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
    # The uniforms pane of a compiled effect: the rows of name / control / value field
    # (the value fields are stacked one row apart) and a mat3's grid of number fields.
    Scenario(
        "editor-03-uniforms",
        "#/effects",
        steps=TO_EDITOR
        + [
            ("fill", "textarea.fxedit-code", UNIFORMS_FX),
            ("wait_for", ".uniform-panel .upanel-mat", 30000),
            ("click", "button[data-pane='uniforms']"),
            ("wait", 600),
        ],
        root=".uniform-panel",
        expect=".uniform-panel .upanel-mat",
    ),
]
