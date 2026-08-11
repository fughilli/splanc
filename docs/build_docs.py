"""Build the splanc developer documentation site — the ``//docs:build`` target.

One invocation regenerates everything:

    bazel run //docs:build

It (1) renders the generated figures/animations from the real pipeline code
(`gen_figures`), then (2) assembles a staging source tree that *mirrors the repo
layout* — so the relative links between the existing markdown docs resolve —
drops in the hand-written pages under `docs/_sphinx/`, and runs Sphinx into
`docs/site/html/`.

Reading the doc content live from ``$BUILD_WORKSPACE_DIRECTORY`` (rather than
from bazel runfiles) means the site always reflects the working tree, matching
the repo's existing ``bazel run //web:gen_fx_vm_perf_doc`` convention.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ``gen_figures`` is a sibling src; make it importable regardless of how the
# py_binary lays out runfiles.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gen_figures  # noqa: E402
from sphinx.cmd.build import main as sphinx_main  # noqa: E402

# Root markdown folded into the site as-is (staged at the mirror root).
ROOT_MD = [
    "README.md",
    "DEVELOPERS.md",
    "EFFECTS.md",
    "led-mapper-design.md",
    "next_steps.md",
]

# Subsystem READMEs `{include}`d by the subsystem pages — mirrored at their real
# repo paths so the include directives line up.
NESTED_READMES = [
    "web/README.md",
    "solver/README.md",
    "tools/sim_studio/README.md",
]

# App icons that the raw-HTML banners in README/design docs reference. Mirrored
# under `_assets/` (an html_extra_path), so they land at `web/public/icons/...`
# in the output, exactly where the markup points.
ICONS_DIR = "web/public/icons"


def _workspace_root() -> Path:
    env = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
    if env:
        return Path(env)
    # Fallbacks for running outside `bazel run`.
    try:
        top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
        return Path(top)
    except Exception:
        return Path.cwd()


def _copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _stage(ws: Path, stage: Path) -> None:
    """Assemble the Sphinx source tree in ``stage``."""
    sphinx_src = ws / "docs" / "_sphinx"

    # 1. The hand-written Sphinx project (conf.py, index, architecture,
    #    subsystems/, design/, _static/) at the mirror root.
    for item in sphinx_src.iterdir():
        target = stage / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            _copy(item, target)

    # 2. Root markdown, mirrored at the top level.
    for name in ROOT_MD:
        src = ws / name
        if src.exists():
            _copy(src, stage / name)

    # 3. Everything under docs/ that is content (skip the Sphinx project, the
    #    generators, build outputs, and BUILD files).
    docs_dir = ws / "docs"
    skip_top = {"_sphinx", "site", "_build", "__pycache__"}
    for md in sorted(docs_dir.rglob("*.md")):
        rel = md.relative_to(docs_dir)
        if rel.parts and rel.parts[0] in skip_top:
            continue
        _copy(md, stage / "docs" / rel)

    # 4. Subsystem READMEs at their real paths.
    for rel in NESTED_READMES:
        src = ws / rel
        if src.exists():
            _copy(src, stage / rel)

    # 5. Icons: into _static (theme logo) and _assets mirror (raw-HTML refs).
    icons = ws / ICONS_DIR
    static = stage / "_static"
    static.mkdir(parents=True, exist_ok=True)
    logo = icons / "splanc.svg"
    banner = icons / "splanc-banner.svg"
    if logo.exists():
        _copy(logo, static / "splanc-icon.svg")
    if banner.exists():
        _copy(banner, static / "splanc-banner.svg")
    if icons.is_dir():
        shutil.copytree(icons, stage / "_assets" / ICONS_DIR, dirs_exist_ok=True)


# Sphinx emits ``_``-prefixed asset dirs (_static, _images, _sources, and
# sphinx-design's _sphinx_design_static). GitHub Pages runs Jekyll, which drops
# every ``_``-prefixed path — so on Pages the CSS/JS/images all 404 (giant icons,
# fallback font). A ``.nojekyll`` only helps at the *site root*, which a
# ``pr-preview/pr-N/`` subdirectory can't set. So instead we make the output
# Jekyll-safe: rename those dirs and rewrite the references, so the site is served
# verbatim on any static host (Pages root, Pages PR previews, Cloudflare, the Pi).
# Order matters — ``_sphinx_design_static`` contains ``_static`` — so the regexes
# use a leading-boundary lookbehind and are applied longest-first.
_UNDERSCORE_DIRS = [
    ("_sphinx_design_static", "sphinx_design_static"),
    ("_static", "static"),
    ("_images", "images"),
    ("_sources", "sources"),
    ("_downloads", "downloads"),
]


def _make_jekyll_safe(out_dir: Path) -> None:
    # Rename the top-level asset directories.
    for old, new in _UNDERSCORE_DIRS:
        src = out_dir / old
        if src.is_dir():
            shutil.move(str(src), str(out_dir / new))
    # Rewrite references in every text asset. The lookbehind ``(?<![\w])`` keeps
    # ``design_static`` (inside the already-renamed sphinx_design_static) from
    # matching the ``_static`` rule.
    subs = [
        (re.compile(r"(?<![\w])" + re.escape(old) + r"\b"), new) for old, new in _UNDERSCORE_DIRS
    ]
    for path in out_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".html", ".js", ".css"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        new_text = text
        for pat, new in subs:
            new_text = pat.sub(new, new_text)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
    # Belt and suspenders: a .nojekyll so the tree is also correct if it ever
    # becomes the Pages site root, at no cost.
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    ws = _workspace_root()
    out_dir = Path(argv[0]) if argv else ws / "docs" / "site" / "html"

    stage = Path(tempfile.mkdtemp(prefix="splanc-docs-"))
    try:
        print(f"==> staging docs sources from {ws}", file=sys.stderr)
        _stage(ws, stage)

        print("==> generating figures + animations (simulator -> reconstruction)", file=sys.stderr)
        gen_figures.generate_all(stage / "_generated")

        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"==> running Sphinx -> {out_dir}", file=sys.stderr)
        # -j auto: parallel; keep warnings visible but non-fatal.
        rc = sphinx_main(["-b", "html", "-j", "auto", str(stage), str(out_dir)])
        if rc != 0:
            print(f"Sphinx build failed (rc={rc})", file=sys.stderr)
            return rc
        _make_jekyll_safe(out_dir)
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    index = out_dir / "index.html"
    print(f"\n✅ docs built: {index}", file=sys.stderr)
    print("   preview with:  bazel run //docs:serve", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
