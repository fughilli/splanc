"""Headless end-to-end smoke test of the virtual LED wall player (tools/wall.py).

    bazel run //pi/player_rs:wall_smoke

Starts the real `player_host` the way `//pi/player_rs:wall` does (no LED
output, serving the built web app), opens https://localhost:<port>/wall.html in
headless Chromium, and plays the phone: hello, then start_mapping over real WSS
from this process (a second client, like the phone next to the wall). Then:

1. the plain HTTPS port answers the app's certificate-trust popup (`/`);
2. the wall page, served from the player's origin, connects to the player
   same-origin, adopts the code book + pattern epoch the "phone" started (its
   status line reports the LED count and PATTERN RUNNING);
3. DECODE: snapshots of the canvas at every LED's centre each match exactly the
   colours the hue-code kernel (`//firmware/pattern`, the Python binding the M1
   driver uses) prescribes for one frame of the cycle, and that frame is the one
   the PLAYER's clock says is due (+/- 1 frame), so the wall shows the phone's
   pattern, phase-locked to the player's pattern clock;
4. stop_mapping takes the wall back to idle;
5. hue code v2 phase 2: a second capture that asks for the staggered pilot
   (start_mapping syncPattern "stagger_pilot"; the host player advertises
   hue_stagger_pilot) gets it: the wall reports `sync stagger_pilot`, and its
   canvas decodes the same way against the kernel's STAGGERED frames (each LED's
   cycle rotated by its own phase, green/magenta in place of white/green) — no
   frame is all-white, and a v1 frame never matches.

Not part of `bazel test //...` (it needs a browser); Chromium is installed into
the Playwright cache on first run.
"""

import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

import ledmapper_pattern as pattern
from playwright.sync_api import sync_playwright
from python.runfiles import runfiles
from websockets.sync.client import connect

LEDS = 64
COLS = 8
SYMBOLS = 2
BIT_PERIOD_MS = 250.0


def check(cond: bool, what: str) -> None:
    print(("PASS " if cond else "FAIL ") + what, flush=True)
    if not cond:
        raise SystemExit(1)


# -- protobuf, by hand (field numbers from shared/protocol/proto/ledmapper.proto)


def varint(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def ld(f: int, data: bytes) -> bytes:
    return varint((f << 3) | 2) + varint(len(data)) + data


def vi(f: int, v: int) -> bytes:
    return varint(f << 3) + varint(v)


def dbl(f: int, v: float) -> bytes:
    return varint((f << 3) | 1) + struct.pack("<d", v)


def arm(reply: bytes) -> int:
    v = sh = i = 0
    while True:
        b = reply[i]
        v |= (b & 0x7F) << sh
        sh += 7
        i += 1
        if not b & 0x80:
            return v >> 3


HELLO = ld(1, b"")
START_OPTS = vi(1, LEDS) + vi(2, SYMBOLS) + dbl(3, BIT_PERIOD_MS) + dbl(4, 1.0)
START = ld(3, ld(1, START_OPTS))
# StartMappingOptions.sync_pattern = 12: ask for the hue code v2 staggered pilot.
START_STAGGER = ld(3, ld(1, START_OPTS + ld(12, b"stagger_pilot")))
STOP = ld(5, vi(1, 0))  # solveOnHost=false: this player has no solver


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def ensure_chromium() -> None:
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], env=env, check=True)


# Canvas pixels at each LED centre. Mirrors the wall's planar grid layout
# (web/src/wall/main.ts layoutFor/ledCenter: margin 48 canvas px, row-major).
SAMPLE_JS = """([n, cols]) => {
  const c = document.getElementById('wall');
  const ctx = c.getContext('2d');
  const m = 48, rows = Math.ceil(n / cols);
  const pitch = Math.min((c.width - 2 * m) / cols, (c.height - 2 * m) / rows);
  const x0 = (c.width - pitch * cols) / 2 + pitch / 2;
  const y0 = (c.height - pitch * rows) / 2 + pitch / 2;
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (let id = 0; id < n; id++) {
    const x = Math.round(x0 + (id % cols) * pitch), y = Math.round(y0 + Math.floor(id / cols) * pitch);
    const o = (y * c.width + x) * 4;
    out.push([img[o], img[o + 1], img[o + 2]]);
  }
  return out;
}"""


def matching_frames(px, frames):
    def close(a, b):
        return all(abs(x - y) <= 3 for x, y in zip(a, b))

    return [f for f, want in enumerate(frames) if all(close(p, w) for p, w in zip(px, want))]


def decode_cycles(page, t_send: float, sync: str) -> None:
    """Snapshot the canvas for >= 1.5 cycles: every snapshot must be exactly one
    of the kernel's frames for `sync` (and the one the player clock has due)."""
    cycle = pattern.cycle_frames(LEDS, SYMBOLS, "secded")
    frames = [pattern.frame_rgb(f, LEDS, SYMBOLS, "secded", sync) for f in range(cycle)]
    other = "on_off" if sync != "on_off" else "stagger_pilot"
    wrong = [pattern.frame_rgb(f, LEDS, SYMBOLS, "secded", other) for f in range(cycle)]
    seen, late, white, pilots = set(), [], 0, 0
    deadline = time.monotonic() + max(6.0, 1.5 * cycle * BIT_PERIOD_MS / 1000)
    while time.monotonic() < deadline:
        t0 = time.monotonic()
        px = page.evaluate(SAMPLE_JS, [LEDS, COLS])
        t1 = time.monotonic()
        got = matching_frames(px, frames)
        if not got:
            check(False, f"[{sync}] snapshot matches a kernel frame: {px[:6]}...")
        check(not matching_frames(px, wrong), f"[{sync}] snapshot is not a {other} frame")
        white += all(tuple(p) == (255, 255, 255) for p in px)
        pilots += sum(1 for p in px if tuple(p) in ((0, 255, 0), (255, 0, 255)))
        due = {
            int(((t - t_send) * 1000) // BIT_PERIOD_MS) % cycle
            for t in (t0 - BIT_PERIOD_MS / 1000, t0, t1, t1 + BIT_PERIOD_MS / 1000)
        }
        if not set(got) & due:
            late.append((got, sorted(due)))
        seen.update(got)
        time.sleep(BIT_PERIOD_MS / 1000 / 3)
    check(
        len(seen) >= min(cycle, 8),
        f"[{sync}] wall stepped through {len(seen)}/{cycle} distinct kernel frames",
    )
    check(not late, f"[{sync}] every frame was the one the player clock had due (+/-1): {late[:3]}")
    if sync == "stagger_pilot":
        check(white == 0 and pilots > 0, f"[{sync}] no all-white frame; {pilots} pilot dots seen")
    else:
        check(white > 0, f"[{sync}] v1 shows its all-white sync frame")


def main() -> None:
    r = runfiles.Create()
    host_bin = r.Rlocation("_main/pi/player_rs/player_host")
    web_root = r.Rlocation("_main/web/dist")
    port = free_port()
    work = tempfile.mkdtemp(prefix="wall_smoke_")
    log = open(os.path.join(work, "player.log"), "w")
    player = subprocess.Popen(
        [host_bin, "--output", "null", "--leds", "400", "--name", "Virtual wall"]
        + ["--state-dir", "", "--serve-port", str(port), "--web-root", web_root],
        stderr=log,
    )
    insecure = ssl.create_default_context()
    insecure.check_hostname = False
    insecure.verify_mode = ssl.CERT_NONE
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                time.sleep(0.1)

        # 1. The trust page the app's certificate popup lands on.
        page_html = (
            urllib.request.urlopen(f"https://localhost:{port}/", context=insecure).read().decode()
        )
        check(
            "ledmapper-cert-ok" in page_html and "wall.html" in page_html,
            "GET / is the trust page, links the wall",
        )

        ensure_chromium()
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(
                ignore_https_errors=True, viewport={"width": 1280, "height": 720}
            )
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"https://localhost:{port}/wall.html?cols={COLS}")
            status = page.locator("#status")
            page.wait_for_function(
                "document.getElementById('status').textContent.includes('offset ')", timeout=15000
            )
            check(True, f"wall connected same-origin: {status.text_content()!r}")
            check("idle" in status.text_content(), "wall idle before the phone starts mapping")

            # 2. The "phone": a second client on the same player.
            phone = connect(f"wss://localhost:{port}/ws", ssl=insecure)
            phone.send(HELLO)
            check(arm(phone.recv(timeout=5)) == 1, "phone hello -> welcome")
            t_send = time.monotonic()
            phone.send(START)
            reply = phone.recv(timeout=5)
            check(arm(reply) == 3, "phone start_mapping -> mapping_started")

            page.wait_for_function(
                "document.getElementById('status').textContent.includes('PATTERN RUNNING')",
                timeout=10000,
            )
            text = status.text_content()
            check(
                f"{LEDS} LEDs ({COLS}×{LEDS // COLS})" in text,
                f"wall adopted the phone's code book: {text!r}",
            )

            # 3. Decode the canvas against the kernel, frame by frame.
            decode_cycles(page, t_send, "on_off")
            # 4. Stop: back to idle.
            phone.send(STOP)
            check(arm(phone.recv(timeout=5)) == 10, "phone stop_mapping -> mapping_stopped")
            page.wait_for_function(
                "document.getElementById('status').textContent.includes('idle')", timeout=10000
            )
            check(True, "wall back to idle after stop_mapping")

            # 5. Hue code v2 phase 2: the staggered pilot, requested by the phone.
            t_send = time.monotonic()
            phone.send(START_STAGGER)
            reply = phone.recv(timeout=5)
            check(
                arm(reply) == 3, "phone start_mapping(syncPattern=stagger_pilot) -> mapping_started"
            )
            check(b"stagger_pilot" in reply, "the player granted the staggered pilot (codeParams)")
            page.wait_for_function(
                "document.getElementById('status').textContent.includes('sync stagger_pilot')",
                timeout=10000,
            )
            check(True, f"wall renders the staggered pilot: {status.text_content()!r}")
            decode_cycles(page, t_send, "stagger_pilot")
            phone.send(STOP)
            check(arm(phone.recv(timeout=5)) == 10, "phone stop_mapping -> mapping_stopped")
            phone.close()
            check(not [e for e in errors if not re.search("truth", e)], f"no page errors: {errors}")
            browser.close()
    finally:
        player.terminate()
        player.wait()
    print("ALL PASS")


if __name__ == "__main__":
    main()
