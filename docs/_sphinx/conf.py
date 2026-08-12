"""Sphinx configuration for the splanc developer documentation.

This file is copied into a staging source tree by ``docs/build_docs.py`` (the
``//docs:build`` target); it is not run in place. The staging tree mirrors the
repo layout for the existing markdown so the relative links between docs resolve,
and adds the hand-written overview/architecture/subsystem pages plus the
generated figures under ``_generated/``.
"""

from __future__ import annotations

project = "splanc"
copyright = "Kevin Balke and the splanc contributors — AGPL-3.0-or-later"
author = "the splanc contributors"

# -- General ---------------------------------------------------------------

extensions = [
    "myst_parser",  # fold the existing markdown in as-is
    "sphinx_copybutton",  # copy buttons on code blocks
    "sphinx_design",  # cards / grids on the landing + subsystem pages
    "sphinxcontrib.mermaid",  # architecture + dataflow diagrams
]

# MyST: enough extensions that the existing docs (which lean on GitHub-flavored
# markdown — tables, ``$``-math-free, deep heading nesting, raw HTML banners)
# render faithfully.
myst_enable_extensions = [
    "colon_fence",  # ::: fenced directives
    "deflist",
    "fieldlist",
    "html_image",  # <img ...> in the existing README/design docs
    "substitution",
    "tasklist",
]
myst_heading_anchors = 4  # anchor every heading up to h4 for cross-doc links

# The existing docs nest well past h3 (opcode tables, module breakdowns); don't
# let that trip the default title-underline / heading checks.
suppress_warnings = [
    "myst.header",
    "myst.xref_missing",
    "toc.not_readable",
    "misc.highlighting_failure",
]

source_suffix = {".md": "markdown", ".rst": "restructuredtext"}
root_doc = "index"

# The staging tree carries a mirror of the repo. Keep Sphinx from wandering into
# copied build detritus or the source-of-truth trees we don't want as pages.
exclude_patterns = [
    "_build",
    "Thumbs.db",
    ".DS_Store",
    "**/node_modules",
    "**/__pycache__",
    "WORKLOG.md",  # long append-only build log; linked, not paginated
    "web/WORKLOG.md",
]

# -- HTML output -----------------------------------------------------------

html_title = "splanc developer docs"
html_theme = "furo"
html_static_path = ["_static"]
html_css_files = ["custom.css"]
html_logo = "_static/splanc-icon.svg"
html_favicon = "_static/splanc-icon.svg"

# ``_assets/`` mirrors the repo's ``web/public/icons`` under the output root so
# the raw-HTML banners in README.md / design docs keep resolving their images.
html_extra_path = ["_assets"]

html_theme_options = {
    "sidebar_hide_name": False,
    "navigation_with_keys": True,
    "source_repository": "https://github.com/fughilli/splanc/",
    "source_branch": "main",
    "source_directory": "docs/_sphinx/",
    "light_css_variables": {
        "color-brand-primary": "#084de7",
        "color-brand-content": "#084de7",
    },
    "dark_css_variables": {
        "color-brand-primary": "#5b9bff",
        "color-brand-content": "#5b9bff",
    },
}

# Pin the mermaid runtime so the diagrams render the same way offline-cached
# builds do (sphinxcontrib-mermaid loads it from a CDN by default).
mermaid_version = "11.4.1"
mermaid_init_js = "mermaid.initialize({startOnLoad:true, theme:'default'});"

# Copy-button: strip common shell/REPL prompts so pasted commands are clean.
copybutton_prompt_text = r">>> |\.\.\. |\$ "
copybutton_prompt_is_regexp = True
