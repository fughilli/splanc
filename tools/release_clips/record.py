"""Record feature-preview clips: drive the built app in headless Chromium through
a clip script and encode what the screen showed.

Frames come from the DevTools screencast (crisp device-pixel JPEGs, each with
its timestamp), not Playwright's recordVideo (1x, low bitrate). ffmpeg then
turns them into, per clip and framing:

    <id>-<framing>.mp4    H.264, yuv420p, faststart (the app's inline player)
    <id>-<framing>.webm   VP9 (a second <source>; smaller where supported)
    <id>-<framing>.gif    small looping preview (GitHub release bodies)
    <id>-<framing>.jpg    poster frame

The app is served from a built ``//web:dist`` by a local static server, with
the clip's fixture files layered on top. Demo seams only (``?demo=``, seeded
localStorage, fixture JSON): no real device, account or user data is involved.
"""

from __future__ import annotations

import base64
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Optional

from clipspec import MAX_SECONDS, ClipSpec

VIEWPORTS = {
    # (css viewport, device scale, output widths: mp4/webm, gif)
    "phone": ({"width": 390, "height": 844}, 2, 600, 280),
    "desktop": ({"width": 1280, "height": 800}, 1, 1120, 560),
}

# Before the app boots: no first-run hint, no splash, no AI hint bubble (they
# would overlay the demo), and the clip's theme.
SEED_JS = """
(() => {
  const theme = %(theme)s;
  try {
    localStorage.setItem('ledmapper.tour', JSON.stringify({dismissed:true, hintSeen:true, completed:[]}));
    localStorage.setItem('ledmapper.aiHintDismissed', '1');
    const a = JSON.parse(localStorage.getItem('ledmapper.appearance') || '{}');
    a.splash = false; a.mode = theme;
    localStorage.setItem('ledmapper.appearance', JSON.stringify(a));
    const extra = %(storage)s;
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  } catch (e) {}
})();
"""

# The on-screen finger and caption pill (pointer-events: none; outside the app's DOM tree).
OVERLAY_JS = """
(() => {
  if (window.__clip) return;
  const css = `
  #__clip_finger { position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
    border-radius: 50%; background: rgba(255,255,255,.6); box-shadow: 0 2px 12px rgba(0,0,0,.28);
    pointer-events: none; z-index: 2147483647; opacity: 0;
    /* Position with the translate property and depress with scale: the two compose as
       translate(scale(p)), so the press shrinks the dot in place. (Scaling an element whose
       position is in transform also scales that translation, so the dot jumped toward the
       top-left corner on every tap and sprang back.) */
    transition: translate .45s cubic-bezier(.3,.7,.3,1), opacity .25s, scale .14s ease-out,
      background-color .14s; }
  #__clip_finger.down { background: rgba(255,255,255,.85); scale: .82; }
  /* The tap pulse: a filled disc that grows out of the dot and fades (no stroke). */
  #__clip_finger::after { content: ''; position: absolute; inset: 0; border-radius: 50%;
    background: rgba(255,255,255,.45); opacity: 0; scale: 1; pointer-events: none; }
  #__clip_finger.pulse::after { animation: __clip_pulse .5s ease-out; }
  @keyframes __clip_pulse { from { opacity: .7; scale: 1; } to { opacity: 0; scale: 2.3; } }
  #__clip_caption { position: fixed; left: 50%; top: 14px; translate: -50% 0; max-width: calc(100% - 32px);
    padding: 8px 14px; border-radius: 999px; background: rgba(15,15,22,.86); color: #fff;
    font: 600 15px/1.3 system-ui, sans-serif; pointer-events: none; z-index: 2147483647;
    opacity: 0; transition: opacity .25s; text-align: center; }`;
  const boot = () => {
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const f = document.createElement('div'); f.id = '__clip_finger'; document.documentElement.appendChild(f);
    const c = document.createElement('div'); c.id = '__clip_caption'; document.documentElement.appendChild(c);
    window.__clip = {
      move(x, y) {
        if (f.style.opacity !== '1') {  // appearing: jump there, then fade in (no fly-in from the corner)
          f.style.transition = 'none'; f.style.translate = `${x}px ${y + 40}px`;
          void f.offsetWidth; f.style.transition = '';
        }
        f.style.opacity = '1'; f.style.translate = `${x}px ${y}px`;
      },
      press(on) {
        f.classList.toggle('down', on);
        if (on) { f.classList.remove('pulse'); void f.offsetWidth; f.classList.add('pulse'); }
      },
      hide() { f.style.opacity = '0'; },
      caption(t) { c.textContent = t || ''; c.style.opacity = t ? '1' : '0'; },
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
"""

VERSION_RE = re.compile(rb"(gitDirty:!(?:0|1),version:`)([^`]*)(`)")


def ffmpeg_exe() -> str:
    env = os.environ.get("FFMPEG")
    if env:
        return env
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    found = shutil.which("ffmpeg")
    if not found:
        sys.exit("release_clips: no ffmpeg (set $FFMPEG, or install imageio-ffmpeg / ffmpeg)")
    return found


# -- serving -------------------------------------------------------------------


class _Handler(http.server.SimpleHTTPRequestHandler):
    fixtures: dict[str, str] = {}
    app_version: str = ""

    def log_message(self, *a, **k):  # quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        src = self.fixtures.get(path)
        if src is not None:
            return self._send_file(src)
        if self.app_version and path.endswith(".js"):
            local = self.translate_path(path)
            if os.path.isfile(local):
                with open(local, "rb") as f:
                    data = f.read()
                if b"gitDirty:" in data:
                    v = self.app_version.encode()
                    data = VERSION_RE.sub(lambda m: m[1] + v + m[3], data)
                    return self._send_bytes(data, "text/javascript")
        return super().do_GET()

    def _send_file(self, src: str):
        with open(src, "rb") as f:
            data = f.read()
        ctype = self.guess_type(src)
        self._send_bytes(data, ctype)

    def _send_bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def serve(dist: str, fixtures: dict[str, str], app_version: str) -> tuple[_Server, int]:
    handler = type(
        "ClipHandler", (_Handler,), {"fixtures": dict(fixtures), "app_version": app_version}
    )
    httpd = _Server(("127.0.0.1", 0), functools.partial(handler, directory=dist))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


# -- recording -----------------------------------------------------------------


@dataclass
class Frame:
    ts: float
    path: str


class Recorder:
    """Collects screencast frames for one page."""

    def __init__(self, page, frames_dir: str, width: int, height: int) -> None:
        self.page = page
        self.dir = frames_dir
        self.frames: list[Frame] = []
        self.cdp = page.context.new_cdp_session(page)
        self.cdp.on("Page.screencastFrame", self._on_frame)
        self.size = (width, height)
        self.t_start = 0.0
        self.t_end = 0.0

    def _on_frame(self, params: dict) -> None:
        try:
            self.cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
        except Exception:
            return
        ts = params.get("metadata", {}).get("timestamp") or time.time()
        path = os.path.join(self.dir, f"{len(self.frames):05d}.jpg")
        with open(path, "wb") as f:
            f.write(base64.b64decode(params["data"]))
        self.frames.append(Frame(ts, path))

    def start(self) -> None:
        w, h = self.size
        self.t_start = time.time()
        self.cdp.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 90, "maxWidth": w, "maxHeight": h, "everyNthFrame": 1},
        )

    def stop(self) -> None:
        self.t_end = time.time()
        try:
            self.cdp.send("Page.stopScreencast")
        except Exception:
            pass


def _center(page, selector: str, nth: int = 0) -> tuple[float, float]:
    loc = page.locator(selector).nth(nth)
    loc.scroll_into_view_if_needed(timeout=8000)
    box = loc.bounding_box(timeout=8000)
    if not box:
        raise RuntimeError(f"{selector!r} has no box (hidden?)")
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def run_step(page, step: dict, *, show: bool) -> None:
    """Perform one clip step. `show` draws the finger (recorded steps only)."""
    if "click" in step:
        nth = step.get("nth", 0)
        if show:
            x, y = _center(page, step["click"], nth)
            page.evaluate("([x, y]) => window.__clip && window.__clip.move(x, y)", [x, y])
            page.wait_for_timeout(520)
            page.evaluate("() => window.__clip && window.__clip.press(true)")
            page.wait_for_timeout(130)
        page.locator(step["click"]).nth(nth).click(timeout=8000, force=bool(step.get("force")))
        if show:
            page.evaluate("() => window.__clip && window.__clip.press(false)")
            page.wait_for_timeout(100)
            page.evaluate("() => window.__clip && window.__clip.hide()")
        page.wait_for_timeout(step.get("wait", 700))
    elif "type" in step:
        if show:
            x, y = _center(page, step["type"])
            page.evaluate("([x, y]) => window.__clip && window.__clip.move(x, y)", [x, y])
            page.wait_for_timeout(400)
            page.evaluate("() => window.__clip && window.__clip.hide()")
        loc = page.locator(step["type"]).first
        loc.click(timeout=8000)
        loc.press_sequentially(step["text"], delay=step.get("delay", 70) if show else 0)
        page.wait_for_timeout(step.get("wait", 500))
    elif "press" in step:
        page.keyboard.press(step["press"])
        page.wait_for_timeout(step.get("wait", 500))
    elif "scroll" in step:
        sel, by, dur = step["scroll"], step["by"], step.get("duration", 900) if show else 0
        page.evaluate(
            """([sel, by, dur]) => new Promise((done) => {
              const el = sel === 'page' ? document.scrollingElement : document.querySelector(sel);
              if (!el) return done(false);
              // Ease over the distance the element can actually travel, so a scroll that
              // would overrun the end still eases out at the end instead of hitting it.
              const y0 = el.scrollTop, max = Math.max(0, el.scrollHeight - el.clientHeight);
              by = Math.max(-y0, Math.min(max - y0, by));
              const t0 = performance.now();
              const ease = (t) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
              const tick = (now) => {
                const t = dur ? Math.min(1, (now - t0) / dur) : 1;
                el.scrollTop = y0 + by * ease(t);
                if (t < 1) requestAnimationFrame(tick); else done(true);
              };
              requestAnimationFrame(tick);
            })""",
            [sel, by, dur],
        )
        page.wait_for_timeout(step.get("wait", 400))
    elif "select" in step:
        if show:
            x, y = _center(page, step["select"])
            page.evaluate("([x, y]) => window.__clip && window.__clip.move(x, y)", [x, y])
            page.wait_for_timeout(450)
            page.evaluate("() => window.__clip && window.__clip.hide()")
        page.locator(step["select"]).first.select_option(label=step["label"], timeout=8000)
        page.wait_for_timeout(step.get("wait", 700))
    elif "hover" in step:
        page.locator(step["hover"]).first.hover(timeout=8000)
        page.wait_for_timeout(step.get("wait", 500))
    elif "wait_for" in step:
        page.locator(step["wait_for"]).first.wait_for(
            state="visible", timeout=step.get("timeout", 10000)
        )
    elif "caption" in step:
        page.evaluate("(t) => window.__clip && window.__clip.caption(t)", step["caption"])
        page.wait_for_timeout(step.get("ms", 1600))
        page.evaluate("() => window.__clip && window.__clip.caption('')")
    elif "wait" in step:
        page.wait_for_timeout(step["wait"])


@dataclass
class Take:
    spec: ClipSpec
    framing: str
    frames: list[Frame]
    t_start: float
    t_end: float
    poster_ts: float
    frames_dir: str


def record_take(browser, base_url: str, spec: ClipSpec, framing: str, work: str) -> Take:
    viewport, scale, _, _ = VIEWPORTS[framing]
    ctx = browser.new_context(
        viewport=viewport,
        device_scale_factor=scale,
        is_mobile=framing == "phone",
        has_touch=framing == "phone",
        color_scheme=spec.theme,
        reduced_motion="no-preference",
        locale="en-US",
        timezone_id="America/Los_Angeles",
        service_workers="block",
    )
    ctx.add_init_script(
        SEED_JS % {"theme": json.dumps(spec.theme), "storage": json.dumps(spec.storage)}
    )
    ctx.add_init_script(OVERLAY_JS)
    page = ctx.new_page()
    url = base_url + (f"?demo={spec.demo}" if spec.demo else "") + spec.route
    try:
        page.goto(url, wait_until="networkidle", timeout=20000)
    except Exception:
        page.goto(url, timeout=20000)
    # The shell is up (tab bar), the screen has content, then a beat to settle
    # transitions and the sample library's seeding.
    page.locator(".tab-bar .tab").first.wait_for(state="visible", timeout=20000)
    page.wait_for_function(
        "() => { const o = document.querySelector('.shell-outlet');"
        " return !!o && o.innerText.trim().length > 20; }",
        timeout=20000,
    )
    page.wait_for_timeout(1500)
    for step in spec.setup:
        run_step(page, step, show=False)
    frames_dir = os.path.join(work, f"{spec.id}-{framing}")
    os.makedirs(frames_dir, exist_ok=True)
    w, h = viewport["width"] * scale, viewport["height"] * scale
    rec = Recorder(page, frames_dir, w, h)
    rec.start()
    page.wait_for_timeout(450)  # a still beat before the first action
    deadline = time.time() + MAX_SECONDS
    for step in spec.steps:
        if time.time() > deadline:
            print(f"  {spec.id}: script ran past {MAX_SECONDS:.0f}s; trimmed", file=sys.stderr)
            break
        run_step(page, step, show=True)
    page.wait_for_timeout(spec.tail_ms)
    poster_ts = time.time() - 0.2
    rec.stop()
    page.wait_for_timeout(150)
    ctx.close()
    if not rec.frames:
        raise RuntimeError(f"{spec.id}/{framing}: the screencast produced no frames")
    if spec.poster_at is not None:
        poster_ts = rec.frames[0].ts + spec.poster_at
    return Take(spec, framing, rec.frames, rec.frames[0].ts, rec.t_end, poster_ts, frames_dir)


# -- encoding ------------------------------------------------------------------


def _concat_list(take: Take) -> str:
    """ffconcat input: each frame held until the next one (screencast frames
    only arrive when something changed), capped at MAX_SECONDS."""
    lines = ["ffconcat version 1.0"]
    t0 = take.frames[0].ts
    end = min(take.t_end, t0 + MAX_SECONDS)
    fr = [f for f in take.frames if f.ts - t0 < MAX_SECONDS]
    for i, f in enumerate(fr):
        nxt = fr[i + 1].ts if i + 1 < len(fr) else end
        dur = max(nxt - f.ts, 1 / 60)
        lines.append(f"file '{os.path.basename(f.path)}'")
        lines.append(f"duration {dur:.4f}")
    lines.append(f"file '{os.path.basename(fr[-1].path)}'")  # concat demuxer quirk
    path = os.path.join(take.frames_dir, "list.ffconcat")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def _ff(args: list[str]) -> None:
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", *args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {' '.join(cmd)}\n{r.stderr[-2000:]}")


def encode_take(take: Take, out_dir: str) -> dict:
    _, _, width, gif_width = VIEWPORTS[take.framing]
    stem = f"{take.spec.id}-{take.framing}"
    src = _concat_list(take)
    inp = ["-f", "concat", "-safe", "0", "-i", src]
    scale = f"scale={width}:-2:flags=lanczos"
    mp4 = os.path.join(out_dir, stem + ".mp4")
    _ff([*inp, "-vf", f"fps=30,{scale},format=yuv420p", "-c:v", "libx264", "-preset", "slow",
         "-crf", "27", "-profile:v", "high", "-tune", "animation", "-movflags", "+faststart",
         "-an", mp4])  # fmt: skip
    webm = os.path.join(out_dir, stem + ".webm")
    _ff([*inp, "-vf", f"fps=30,{scale}", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40",
         "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-an", webm])  # fmt: skip
    gif = os.path.join(out_dir, stem + ".gif")
    _ff([*inp, "-vf",
         f"fps=10,scale={gif_width}:-1:flags=lanczos,split[a][b];"
         "[a]palettegen=max_colors=64:stats_mode=diff[p];"
         "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
         "-loop", "0", gif])  # fmt: skip
    poster_frame = take.frames[0]
    for f in take.frames:
        if f.ts <= take.poster_ts:
            poster_frame = f
    poster = os.path.join(out_dir, stem + ".jpg")
    _ff(["-i", poster_frame.path, "-vf", scale, "-q:v", "4", "-frames:v", "1", poster])
    duration = min(take.t_end, take.frames[0].ts + MAX_SECONDS) - take.frames[0].ts
    vw, vh = _probe_size(poster)
    return {
        "framing": take.framing,
        "mp4": os.path.basename(mp4),
        "webm": os.path.basename(webm),
        "gif": os.path.basename(gif),
        "poster": os.path.basename(poster),
        "width": vw,
        "height": vh,
        "duration": round(duration, 2),
        "bytes": {
            k: os.path.getsize(os.path.join(out_dir, v))
            for k, v in (("mp4", mp4), ("webm", webm), ("gif", gif), ("poster", poster))
        },
    }


def _probe_size(jpg: str) -> tuple[int, int]:
    """Width/height of a baseline or progressive JPEG (SOFn marker), stdlib only."""
    with open(jpg, "rb") as f:
        data = f.read()
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        seg = int.from_bytes(data[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            h = int.from_bytes(data[i + 5 : i + 7], "big")
            w = int.from_bytes(data[i + 7 : i + 9], "big")
            return w, h
        i += 2 + seg
    return 0, 0


# -- driver --------------------------------------------------------------------


def ensure_browser() -> None:
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return
    except Exception:
        pass
    print("Installing Chromium for Playwright (one-time)...", file=sys.stderr)
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(x for x in sys.path if x))
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True, env=env)


def record_all(
    specs: list[ClipSpec],
    dist: str,
    repo: str,
    out_dir: str,
    *,
    framings: Optional[list[str]] = None,
    keep_frames: bool = False,
) -> list[dict]:
    """Record + encode every spec (each of its framings). Returns one manifest
    entry per spec; a spec that fails is reported with its error, not fatal."""
    from playwright.sync_api import sync_playwright

    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="clips-frames-")
    entries = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--disable-gpu-vsync"])
            for spec in specs:
                fixtures = {u: os.path.join(repo, s) for u, s in spec.fixtures.items()}
                missing = [s for s in fixtures.values() if not os.path.isfile(s)]
                entry = {**spec.to_json(), "variants": [], "error": None}
                if missing:
                    entry["error"] = f"missing fixture file(s): {missing}"
                    entries.append(entry)
                    continue
                httpd, port = serve(dist, fixtures, spec.app_version)
                try:
                    for framing in framings or spec.framing:
                        if framing not in spec.framing and framings is None:
                            continue
                        t = time.time()
                        take = record_take(
                            browser, f"http://127.0.0.1:{port}/", spec, framing, work
                        )
                        v = encode_take(take, out_dir)
                        entry["variants"].append(v)
                        print(
                            f"  {spec.id}/{framing}: {v['duration']:.1f}s, {len(take.frames)} frames, "
                            f"mp4 {v['bytes']['mp4'] // 1024} KB, gif {v['bytes']['gif'] // 1024} KB "
                            f"({time.time() - t:.0f}s)",
                            file=sys.stderr,
                        )
                except Exception as e:
                    entry["error"] = f"{type(e).__name__}: {e}"
                    print(f"  {spec.id}: FAILED {entry['error']}", file=sys.stderr)
                finally:
                    httpd.shutdown()
                entries.append(entry)
            browser.close()
    finally:
        if keep_frames:
            print(f"frames kept in {work}", file=sys.stderr)
        else:
            shutil.rmtree(work, ignore_errors=True)
    return entries
