"""UI layout guard: no crammed or overlapping controls (owner rule, 2026-11-18).

Reusable by any screen. A *scenario* opens a route of the built app (with
seeded localStorage, a faked network and optional interaction steps); the guard
renders it at phone (390x844) and desktop (1280x800) widths in light and dark,
collects every visible interactive element and fails when

  * two interactive elements overlap,
  * two interactive elements sit closer than ``MIN_GAP_PX`` (8 px), or
  * an interactive element runs off the side of the viewport (a squeezed row).

Controls that are deliberately joined (a segmented control's segments, a
password field's show/hide eye) are exempt among themselves: mark the
container with ``data-layout-joined`` or list its selector in ``JOINED``.

The geometry (:func:`find_violations`) is pure and unit-tested without a
browser (``//tools/ui_layout:layout_guard_test``); the browser half is
``bazel run //tools/ui_layout:ui_layout_check``.
"""

from __future__ import annotations

import dataclasses
import functools
import http.server
import json
import socketserver
import threading
from pathlib import Path
from typing import Callable

MIN_GAP_PX = 8.0
# Sub-pixel rounding slack (layout lands on fractional pixels).
EPS = 0.5

VIEWPORTS = {
    "phone": {"width": 390, "height": 844},
    "desktop": {"width": 1280, "height": 800},
}
THEMES = ("light", "dark")

# What counts as interactive.
INTERACTIVE = (
    "button, a.k-btn, a[role=button], [role=button], [role=radio], [role=tab], [role=switch],"
    " input:not([type=hidden]), select, textarea"
)
# Containers whose interactive children are one joined control.
JOINED = (".settings-seg", ".k-pw", "[data-layout-joined]")

# Collects the rects (viewport coordinates; every rect shares the same scroll
# state, so pairwise geometry holds even below the fold).
COLLECT_JS = r"""
([rootSel, sel, joinedSel]) => {
  const roots = [...document.querySelectorAll(rootSel)];
  const out = [];
  const seen = new Set();
  let id = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (el.closest('[hidden]') || el.getClientRects().length === 0) continue;
      // A visually-hidden native control (custom checkbox / radio skins).
      if (r.width <= 2 && r.height <= 2) continue;
      const joined = el.parentElement && el.parentElement.closest(joinedSel);
      if (!el.dataset.layoutId) el.dataset.layoutId = String(++id);
      out.push({
        id: el.dataset.layoutId,
        x: r.left, y: r.top, w: r.width, h: r.height,
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.className || '')
          .toString().trim().replace(/\s+/g, ' ').slice(0, 48),
        joined: joined ? (joined.dataset.layoutGroup || (joined.dataset.layoutGroup = 'g' + (++id))) : null,
        // ancestors that are themselves interactive (a control nested in a card button)
        ancestors: (() => {
          const a = [];
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (p.dataset && p.dataset.layoutId) a.push(p.dataset.layoutId);
          }
          return a;
        })(),
      });
    }
  }
  return { elements: out, viewport: { w: document.documentElement.clientWidth, h: window.innerHeight } };
}
"""


@dataclasses.dataclass(frozen=True)
class Violation:
    kind: str  # "overlap" | "gap" | "offscreen"
    a: str
    b: str
    detail: str

    def __str__(self) -> str:
        return (
            f"{self.kind}: {self.a!r} / {self.b!r} ({self.detail})"
            if self.b
            else f"{self.kind}: {self.a!r} ({self.detail})"
        )


def _gap(a: dict, b: dict) -> tuple[float, float, float]:
    """(dx, dy, overlap_area) between two rects; dx/dy are the empty space
    between them along each axis (0 when their projections overlap)."""
    ax2, ay2, bx2, by2 = a["x"] + a["w"], a["y"] + a["h"], b["x"] + b["w"], b["y"] + b["h"]
    dx = max(b["x"] - ax2, a["x"] - bx2, 0.0)
    dy = max(b["y"] - ay2, a["y"] - by2, 0.0)
    ox = min(ax2, bx2) - max(a["x"], b["x"])
    oy = min(ay2, by2) - max(a["y"], b["y"])
    area = ox * oy if ox > 0 and oy > 0 else 0.0
    return dx, dy, area


def find_violations(
    elements: list[dict], viewport_w: float | None = None, min_gap: float = MIN_GAP_PX
) -> list[Violation]:
    """Pure geometry over collected rects (see COLLECT_JS for the fields)."""
    out: list[Violation] = []
    for i, a in enumerate(elements):
        # Joined controls are exempt from the pairwise checks only: a segmented
        # bar that runs off the screen is still a squeezed row.
        if viewport_w is not None:
            if a["x"] < -EPS or a["x"] + a["w"] > viewport_w + EPS:
                out.append(
                    Violation(
                        "offscreen",
                        a["label"],
                        "",
                        f"x={a['x']:.0f}..{a['x'] + a['w']:.0f} of {viewport_w:.0f}px",
                    )
                )
        for b in elements[i + 1 :]:
            if a.get("joined") and a.get("joined") == b.get("joined"):
                continue
            if a["id"] in b.get("ancestors", []) or b["id"] in a.get("ancestors", []):
                continue
            dx, dy, area = _gap(a, b)
            if area > EPS:
                out.append(Violation("overlap", a["label"], b["label"], f"{area:.0f}px² overlap"))
                continue
            gap = max(dx, dy)
            if gap < min_gap - EPS:
                out.append(
                    Violation(
                        "gap", a["label"], b["label"], f"{gap:.1f}px apart, need ≥{min_gap:.0f}px"
                    )
                )
    return out


# -- browser half -------------------------------------------------------------------------


@dataclasses.dataclass
class Scenario:
    """One screen state to render and check.

    id:      file-name-safe id (screenshots: <id>-<viewport>-<theme>.png)
    route:   the app hash route, e.g. "#/settings/ai" (may carry ?query=)
    search:  a location.search to load with (e.g. "?checkout=success")
    seed:    localStorage key -> value set before the app boots
    steps:   interaction after load: ("click", selector) | ("fill", selector, text)
             | ("check", selector) | ("wait", ms) | ("wait_for", selector)
    network: makes a per-run request handler: handler(route, request) -> bool
             (True = handled); everything else off-origin is blocked
    root:    where to look for controls (the screen, not the app chrome)
    settle_ms: extra wait after the steps (animations, polling)
    expect:  a selector that must be visible once settled (proves the scenario
             reached the intended screen, not an error or fallback state)
    """

    id: str
    route: str
    search: str = ""
    seed: dict[str, str] = dataclasses.field(default_factory=dict)
    steps: list[tuple] = dataclasses.field(default_factory=list)
    network: Callable[[], Callable] | None = None
    root: str = ".shell-outlet, .k-sheet"
    settle_ms: int = 700
    expect: str | None = None


BASE_SEED = {
    "ledmapper.tour": json.dumps({"dismissed": True, "hintSeen": True, "completed": []}),
    "ledmapper.aiHintDismissed": "1",
}


def seed_js(seed: dict[str, str], theme: str) -> str:
    items = {**BASE_SEED, **seed}
    lines = [f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)});" for k, v in items.items()]
    # Theme + no splash, merged into any seeded appearance.
    lines.append(
        "try { const a = JSON.parse(localStorage.getItem('ledmapper.appearance') || '{}');"
        f" a.splash = false; a.mode = {json.dumps(theme)};"
        " localStorage.setItem('ledmapper.appearance', JSON.stringify(a)); } catch (e) {}"
    )
    # Run once per page load only (a reload must not reset what the app wrote).
    return (
        "if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1');\n"
        + "\n".join(lines)
        + "\n}"
    )


def serve(root: Path) -> tuple[socketserver.TCPServer, int]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            pass

    handler = functools.partial(Quiet, directory=str(root))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run_steps(page, steps: list[tuple]) -> None:
    for st in steps:
        op = st[0]
        if op == "click":
            page.locator(st[1]).first.click(timeout=8000)
        elif op == "fill":
            page.locator(st[1]).first.fill(st[2], timeout=8000)
        elif op == "check":
            page.locator(st[1]).first.check(timeout=8000)
        elif op == "css":  # inject a stylesheet (the guard's self-test crams a row)
            page.add_style_tag(content=st[1])
        elif op == "wait":
            page.wait_for_timeout(st[1])
        elif op == "wait_for":
            page.locator(st[1]).first.wait_for(timeout=st[2] if len(st) > 2 else 8000)
        else:
            raise ValueError(f"unknown step {op!r}")
        page.wait_for_timeout(250)


def check_page(page, root: str) -> tuple[list[Violation], int]:
    """(violations, how many interactive elements were checked)."""
    res = page.evaluate(COLLECT_JS, [root, INTERACTIVE, ", ".join(JOINED)])
    return find_violations(res["elements"], res["viewport"]["w"]), len(res["elements"])


def run_scenarios(
    dist: Path,
    scenarios: list[Scenario],
    shots_dir: Path | None = None,
    viewports: dict | None = None,
    themes: tuple = THEMES,
    log=print,
) -> dict[str, list[Violation]]:
    """Render every scenario x viewport x theme; return violations per variant
    (and write <id>-<viewport>-<theme>.png when shots_dir is set)."""
    from playwright.sync_api import sync_playwright

    viewports = viewports or VIEWPORTS
    httpd, port = serve(dist)
    origin = f"http://127.0.0.1:{port}"
    results: dict[str, list[Violation]] = {}
    if shots_dir:
        shots_dir.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for sc in scenarios:
                for vname, vp in viewports.items():
                    for theme in themes:
                        key = f"{sc.id}-{vname}-{theme}"
                        ctx = browser.new_context(
                            viewport=vp, device_scale_factor=2, color_scheme=theme
                        )
                        ctx.add_init_script(seed_js(sc.seed, theme))
                        handler = sc.network() if sc.network else None

                        def on_route(route, request, handler=handler):
                            if request.url.startswith(origin):
                                return route.continue_()
                            if handler and handler(route, request):
                                return None
                            return route.abort()  # no real network, ever

                        ctx.route("**/*", on_route)
                        page = ctx.new_page()
                        errors: list[str] = []
                        n = 0
                        page.on("pageerror", lambda e, errors=errors: errors.append(str(e)))
                        try:
                            page.goto(
                                f"{origin}/index.html{sc.search}{sc.route}",
                                wait_until="load",
                                timeout=20000,
                            )
                            page.wait_for_timeout(1200)
                            run_steps(page, sc.steps)
                            page.wait_for_timeout(sc.settle_ms)
                            v, n = check_page(page, sc.root)
                            if sc.expect and not page.locator(sc.expect).first.is_visible():
                                v.append(
                                    Violation(
                                        "state",
                                        sc.expect,
                                        "",
                                        "expected element not visible: wrong screen",
                                    )
                                )
                            if n == 0:
                                v.append(
                                    Violation(
                                        "empty",
                                        sc.root,
                                        "",
                                        "no interactive elements found: wrong root or the screen didn't render",
                                    )
                                )
                        except Exception as e:  # a scenario that can't be driven is a failure too
                            v = [
                                Violation(
                                    "error",
                                    str(e).splitlines()[0][:160],
                                    "",
                                    "scenario failed to run",
                                )
                            ]
                        if errors:
                            v.append(
                                Violation(
                                    "pageerror",
                                    errors[0][:160],
                                    "",
                                    f"{len(errors)} uncaught error(s)",
                                )
                            )
                        results[key] = v
                        log(
                            ("FAIL " if v else "ok   ")
                            + f"{key} ({n} controls)"
                            + "".join(f"\n       {x}" for x in v)
                        )
                        if shots_dir:
                            shoot(page, shots_dir / f"{key}.png", vp)
                        ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    return results


def shoot(page, path: Path, vp: dict) -> None:
    """Screenshot the whole screen: grow the viewport to the scrolled content
    so a review shot shows everything below the fold too."""
    try:
        h = page.evaluate(
            "() => { const o = document.querySelector('.shell-outlet');"
            " const s = document.querySelector('.k-sheet-body, .k-sheet');"
            " const extra = (el) => el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;"
            " return window.innerHeight + Math.max(extra(o), extra(s)); }"
        )
        h = int(min(max(h, vp["height"]), 3200))
        if h > vp["height"]:
            page.set_viewport_size({"width": vp["width"], "height": h})
            page.wait_for_timeout(300)
        page.screenshot(path=str(path))
        page.set_viewport_size(vp)
    except Exception:
        page.screenshot(path=str(path))
