"""Regenerate pi/bridge/display/splanc_display/fonts/ from pinned upstream releases.

    pip install fonttools && python3 pi/bridge/tools/vendor_fonts.py [--cache DIR]

The display draws only with these committed files (draw.py / fonts.py): the
NixOS image, the Pi OS bundle, `bazel run //pi/bridge:sim`, a plain-venv sim,
render_gallery and the tests all read the same bytes, so nothing depends on
what a machine happens to have installed. This script is how they were made:
each source archive is fetched by URL and checked against its sha256, then

  * DejaVu (the HDMI page and the "dejavu" OLED set): the four faces, subset
    with fontTools to the scripts a fixture name is likely to use (Latin, Greek,
    Cyrillic) plus punctuation/arrows/shapes. Hinting is kept: the 1-bit OLED
    rendering of 9-10 px DejaVu depends on it. Subsetting keeps each file under
    the repo's 600 KB large-file limit.
  * the bitmap fonts: BDF files subset (pure Python) to the same ranges. BDF is
    read at run time by fonts.py; Pillow's .pil format is not used because it
    holds only 256 glyphs (no "…", no Cyrillic).

Each family's licence is copied next to its files, and SOURCES.txt records the
URL + sha256 of every input and the sha256 of every output (checked by the
tests, so an edit by hand is caught).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import re
import shutil
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "display", "splanc_display", "fonts"))

SOURCES = {
    "dejavu": (
        "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/"
        "dejavu-fonts-ttf-2.37.tar.bz2",
        "fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7",
    ),
    "spleen": (
        "https://github.com/fcambus/spleen/releases/download/2.1.0/spleen-2.1.0.tar.gz",
        "8b47c56f1a6eb858fbcf9e34530557404b02fbb3455e38e64fb84473fd0c372f",
    ),
    "terminus": (
        "https://downloads.sourceforge.net/project/terminus-font/terminus-font-4.49/"
        "terminus-font-4.49.1.tar.gz",
        "d961c1b781627bf417f9b340693d64fc219e0113ad3a3af1a3424c7aa373ef79",
    ),
    "misc-fixed": (
        "https://www.x.org/releases/individual/font/font-misc-misc-1.1.3.tar.xz",
        "79abe361f58bb21ade9f565898e486300ce1cc621d5285bec26e14b6a8618fed",
    ),
    "cozette": (
        "https://github.com/the-moonwitch/Cozette/releases/download/v.1.30.0/cozette.bdf",
        "8d740166af3a14053773ac7a8846bf288c8818a44f73ab28d4725d91b03a5639",
    ),
    "cozette-license": (
        "https://raw.githubusercontent.com/the-moonwitch/Cozette/v.1.30.0/LICENSE",
        None,  # checked by content below (a text file GitHub may re-encode)
    ),
}

# family -> [(member in the archive, file name here)], plus the licence member.
FILES = {
    "dejavu": (
        [
            (f"dejavu-fonts-ttf-2.37/ttf/{n}.ttf", f"{n}.ttf")
            for n in ("DejaVuSans", "DejaVuSans-Bold", "DejaVuSansMono", "DejaVuSansMono-Bold")
        ],
        "dejavu-fonts-ttf-2.37/LICENSE",
    ),
    "spleen": (
        [
            (f"spleen-2.1.0/spleen-{s}.bdf", f"spleen-{s}.bdf")
            for s in ("5x8", "6x12", "8x16", "12x24")
        ],
        "spleen-2.1.0/LICENSE",
    ),
    "terminus": (
        [
            (f"terminus-font-4.49.1/ter-u{s}.bdf", f"ter-u{s}.bdf")
            for s in ("12n", "14b", "16b", "24b")
        ],
        "terminus-font-4.49.1/OFL.TXT",
    ),
    "misc-fixed": (
        [
            (f"font-misc-misc-1.1.3/{s}.bdf", f"{s}.bdf")
            for s in ("5x8", "6x12", "6x13B", "7x13B", "9x15B", "10x20")
        ],
        "font-misc-misc-1.1.3/COPYING",
    ),
}

# Unicode ranges kept (inclusive). Anything else falls back to DejaVu at draw time.
RANGES = [
    (0x0020, 0x007E),  # ASCII
    (0x00A0, 0x024F),  # Latin-1, Latin Extended-A/B
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x04FF),  # Cyrillic
    (0x2010, 0x2027),  # dashes, quotes, bullet, ellipsis
    (0x2030, 0x203A),
    (0x20AC, 0x20AC),  # euro
    (0x2190, 0x2195),  # arrows
    (0x2212, 0x2212),  # minus
    (0x25A0, 0x25CF),  # squares, circles
    (0x2713, 0x2717),  # check / cross marks
]


def keep(cp: int) -> bool:
    return any(a <= cp <= b for a, b in RANGES)


def fetch(url: str, sha: str | None, cache: str) -> bytes:
    path = os.path.join(cache, os.path.basename(url))
    if not os.path.exists(path):
        print("fetching", url, file=sys.stderr)
        with urllib.request.urlopen(url) as r, open(path + ".part", "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(path + ".part", path)
    data = open(path, "rb").read()
    if sha and hashlib.sha256(data).hexdigest() != sha:
        raise SystemExit(f"{url}: sha256 mismatch (got {hashlib.sha256(data).hexdigest()})")
    return data


def subset_bdf(text: str) -> str:
    """The BDF with only the glyphs in RANGES (header CHARS fixed up)."""
    head, _, rest = text.partition("STARTCHAR")
    rest = "STARTCHAR" + rest
    chars = re.findall(r"STARTCHAR.*?ENDCHAR\n", rest, flags=re.S)
    kept = []
    for c in chars:
        m = re.search(r"^ENCODING (-?\d+)", c, flags=re.M)
        if m and keep(int(m.group(1))):
            kept.append(c)
    head = re.sub(r"^CHARS \d+", f"CHARS {len(kept)}", head, flags=re.M)
    return head + "".join(kept) + "ENDFONT\n"


def tidy_text(data: bytes) -> bytes:
    """A licence as the repo's whitespace hooks want it (no trailing spaces, one
    final newline), so they never rewrite a vendored file."""
    lines = data.decode("utf-8", "replace").replace("\r\n", "\n").split("\n")
    return ("\n".join(ln.rstrip() for ln in lines).rstrip("\n") + "\n").encode()


def subset_ttf(data: bytes) -> bytes:
    from fontTools import subset

    opts = subset.Options()
    opts.hinting = True
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    font = subset.load_font(io.BytesIO(data), opts)
    s = subset.Subsetter(opts)
    s.populate(unicodes=[cp for a, b in RANGES for cp in range(a, b + 1)])
    s.subset(font)
    out = io.BytesIO()
    subset.save_font(font, out, opts)
    return out.getvalue()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/splanc-fonts"))
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    os.makedirs(a.cache, exist_ok=True)
    manifest = []
    for fam, (members, lic) in FILES.items():
        url, sha = SOURCES[fam]
        tf = tarfile.open(fileobj=io.BytesIO(fetch(url, sha, a.cache)))
        d = os.path.join(a.out, fam)
        os.makedirs(d, exist_ok=True)
        manifest.append(f"{fam}: {url} sha256={sha}")
        for member, name in members + [(lic, "LICENSE")]:
            data = tf.extractfile(member).read()
            if name.endswith(".ttf"):
                data = subset_ttf(data)
            elif name.endswith(".bdf"):
                data = subset_bdf(data.decode("latin-1")).encode("latin-1")
            else:
                data = tidy_text(data)
            with open(os.path.join(d, name), "wb") as f:
                f.write(data)
    # Cozette ships as a bare BDF + its licence.
    d = os.path.join(a.out, "cozette")
    os.makedirs(d, exist_ok=True)
    url, sha = SOURCES["cozette"]
    bdf = subset_bdf(fetch(url, sha, a.cache).decode("utf-8"))
    with open(os.path.join(d, "cozette.bdf"), "w", encoding="utf-8") as f:
        f.write(bdf)
    manifest.append(f"cozette: {url} sha256={sha}")
    lic = fetch(SOURCES["cozette-license"][0], None, a.cache)
    if b"MIT License" not in lic:
        raise SystemExit("cozette LICENSE: not the MIT licence")
    with open(os.path.join(d, "LICENSE"), "wb") as f:
        f.write(tidy_text(lic))
    manifest.append(f"cozette LICENSE: {SOURCES['cozette-license'][0]}")
    manifest.append("")
    manifest.append("outputs (sha256, path):")
    for root, _, files in sorted(os.walk(a.out)):
        for n in sorted(files):
            if n == "SOURCES.txt":
                continue
            p = os.path.join(root, n)
            rel = os.path.relpath(p, a.out)
            manifest.append(f"{hashlib.sha256(open(p, 'rb').read()).hexdigest()}  {rel}")
    with open(os.path.join(a.out, "SOURCES.txt"), "w") as f:
        f.write(
            "Generated by pi/bridge/tools/vendor_fonts.py from these pinned sources:\n\n"
            + "\n".join(manifest)
            + "\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
