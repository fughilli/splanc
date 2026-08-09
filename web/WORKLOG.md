# Splanc web UI — worklog

Handoff notes alongside git history (newest first). Git is ground truth for what
exists; this file records _intent_ — what's in flight, what's next, and why.
Reference commits by hash rather than re-describing them.

## FOLLOW-UP: Blender-style 3D transform gizmo (Map detail)

**Status:** deferred, not started. The Transform panel it pairs with is done
(X/Y/Z fields + Apply, icon tiles — commit `8a9fc16`). The gizmo is the remaining
"item 6" from the Map-detail redesign.

**Goal:** an in-viewport gizmo on the Map-detail 3D view, anchored at the map
centroid, active while the **Transform** panel is open:

- Draggable **axis arrows** (X/Y/Z) — translate along an axis and rotate about it.
- **Plane handles** — translation locked to a plane, tracking the finger.
- A **rotation ring** with graduations; moving the pointer **inside** the ring
  snaps rotation to discrete **45°** steps.

**Why it's deferred / non-trivial:** `MapView` (`web/src/ui/mapview.ts`) keeps its
world→screen projection as a **private closure inside `draw()`**, and pointer
input there drives camera **orbit** (drag → yaw/pitch). Delivering the gizmo needs:

1. Expose the projection (`proj(worldVec3) → {sx, sy, depth}`) and the inverse
   needed for screen→world along a constraint (axis/plane).
2. A gizmo **draw pass** (either inside MapView's `draw()`, or an overlay
   `<canvas>`/SVG kept in sync with the camera each frame).
3. **Hit-testing** pointer positions against handles, and a way to **intercept**
   handle drags _before_ they reach the orbit handler.
4. Drag math per mode: axis-constrained translate (screen delta projected onto
   the axis), rotation about a projected axis, plane-locked translate, ring 45°
   snap. Apply live via the existing `applyXform` / `applyRotateXYZ` /
   `transformMap` (`web/src/geom/mapTransform.ts` — already supports Vec3 scale).

This is easy to get subtly wrong and normally needs **visual iteration**, so it
was intentionally not attempted blind.

**Suggested increments (each testable):**

1. Foundation + **translate gizmo**: expose projection, draw axis arrows at the
   centroid, intercept handle drags, axis-constrained move. (Most of the
   integration lives here.)
2. **Rotate rings** (X/Y/Z) with the 45° in-ring snap.
3. **Plane handles** (finger-locked plane translation).

**Touch points:** `web/src/ui/mapview.ts` (projection + input), the Transform
section of `web/src/ui/screens/mapDetail.ts` (mount/unmount the gizmo with the
panel; reuse `applyXform`/`applyRotateXYZ`), `web/src/geom/mapTransform.ts`.

## Notes

- No headless browser in the dev environment — TS/lint/build gate via
  `tsc --noEmit`, `vite build`, and pre-commit (`prek run --all-files`); the
  effect-editor interactions were reasoned through, not browser-exercised.
