"""Check splanc-splash's HDMI side (the build's check, with check_stream.py).

    check_hdmi.py SPLASH SPLH WORKDIR

SPLASH is the built binary, SPLH the HDMI animation embedded in it
(tools/gen_boot_frames.py --hdmi-out). Checks that

* the C decoder (``splanc-splash hdmi-dump``) gives exactly the frames Python's
  decoder (gen_boot_frames.load_hdmi) gives: the intro, and the loop after it
  has wrapped around more than once; the stage text (palette 240 + coverage) is
  drawn only once the logo is complete, only on the rows under the LED row, and
  centred;
* the outro: a running splash with a file "framebuffer" (``--fb=file:``),
  asked to ``stop hdmi=1 page=<file>``, ends with that framebuffer exactly
  equal to the page splanc-display would draw next, and replies as usual.

Needs gen_boot_frames on the path (Pillow).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

import gen_boot_frames as g


def main(argv) -> int:
    splash, splh, work = argv[1:4]
    fps, w, h, loop, _pal, frames = g.load_hdmi(open(splh, "rb").read())
    n = len(frames) - 1
    period = n - loop
    text = "Rolled back to 1.2.3"
    for fi in (0, 1, loop // 2, loop - 1, loop, loop + 3, n - 1, n, n + period + 5, 7 * n + 11):
        idx = fi if fi < loop else loop + (fi - loop) % period
        out = os.path.join(work, f"dump-{fi}.bin")
        subprocess.run(
            [splash, "hdmi-dump", str(fi), text, out], check=True, stdout=subprocess.DEVNULL
        )
        got = open(out, "rb").read()
        want = frames[idx]
        assert len(got) == w * h, (fi, len(got))
        diff = [i for i in range(w * h) if got[i] != want[i]]
        if fi < loop:
            assert not diff, f"frame {fi}: {len(diff)} pixels differ from the Python decoder"
        else:
            assert diff and all(got[i] >= 240 for i in diff), f"frame {fi}: not just the stage text"
            rows = {i // w for i in diff}
            cols = [i % w for i in diff]
            assert min(rows) > h * 0.8, f"frame {fi}: text above the bottom rows ({min(rows)})"
            mid = (min(cols) + max(cols)) / 2
            assert abs(mid - w / 2) < 8, f"frame {fi}: text not centred ({mid})"
    print(f"HDMI decoder: {n} frames + loop from {loop} match, stage text on the bottom rows")

    # The outro into the app's first page.
    fbw, fbh = 320, 180
    page = os.path.join(work, "page.fb")
    with open(page, "wb") as f:
        f.write(bytes((i * 31 + 7) & 0xFF for i in range(fbw * fbh * 4)))
    fbfile = os.path.join(work, "fb.raw")
    env = dict(os.environ, SPLASH_FOREGROUND="1")
    p = subprocess.Popen(
        [splash, "run", "--oled=none", f"--fb=file:{fbw}x{fbh}:{fbfile}", "--no-rt", "--max=30"],
        env=env,
    )
    time.sleep(2.5)
    t = time.monotonic()
    reply = subprocess.run(
        [splash, "stop", "hdmi=1", f"page={page}"], check=True, capture_output=True, text=True
    ).stdout
    took = time.monotonic() - t
    p.wait(timeout=10)
    assert reply.startswith("ok t0="), reply
    assert open(fbfile, "rb").read() == open(page, "rb").read(), "the outro did not end on the page"
    assert 0.5 < took < 3.0, f"outro took {took:.2f} s"
    print(f"outro: ended on the page after {took:.2f} s; reply {reply.strip()!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
