#!/usr/bin/env python3
"""Mirror Splanc's GitHub release notes into the static site for the in-app
"What's new?" card.

The app never calls the GitHub API at runtime (rate limits, CORS, offline). This
tool runs at deploy time instead, in fughilli/splanc's release + site builds and
in the splanc.io deploy (Studio-Fug/splanc.io scripts/stage-app.mjs), and writes:

    <out>/index.json         the product list (PRODUCTS below: Splanc app,
                             Firmware, Bridge), each with its release count,
                             newest version and per-product file
    <out>/<product>.json     every release of that product, newest first (the
                             app fetches one only when its product is picked)
    <out>/media/<hash>.<ext> every image/video the notes show, downloaded once
                             (content-addressed, shared across products)

A product is a tag prefix: ``app-vX.Y.Z`` is the Splanc app, ``firmware-vX.Y.Z``
the firmware, ``pi-bridge-vX.Y.Z`` the bridge. Other tags (``pi-bridge-ota-*``,
data, scaffold and stage tags) belong to no product and are skipped. Adding a
product is one line in PRODUCTS.

Release bodies come from the API's rendered ``body_html`` (exactly what GitHub
shows on the release page, so drag-and-dropped ``github.com/user-attachments``
images and videos come through). The HTML is parsed into a small JSON node tree
through a strict tag/attribute allowlist: no scripts, styles, event handlers,
iframes or forms survive, and the app builds DOM from the tree with
createElement (it never assigns innerHTML). Every media URL is downloaded and
rewritten to a local ``media/...`` path; image/video release assets that the
body doesn't reference are appended to the notes as a gallery.

Feature-preview clips (docs/release-clips.md): a release with a
``preview-clips.json`` asset gets a ``clips`` list (title, summary, PRs, and per
framing the MP4/WebM/poster as local media), which the card plays inline. The
notes' "Feature previews" section (GIFs for GitHub's page) and the clip assets
are then left out of the body and the gallery, so nothing shows twice.

Node format (``body`` of each release): a text node is a JSON string; an element
is ``{"t": tag, "a": {attr: value}, "c": [children]}`` ("a"/"c" omitted when
empty). Boolean attributes carry ``true``.

Stdlib only, so it also runs as a plain ``python3 whatsnew_mirror.py`` on a CI
runner without Bazel. Usage:

    whatsnew_mirror.py --out _site/whatsnew [--repo fughilli/splanc]
                       [--up-to app-v1.15.0] [--limit N]   # N per product; 0 = all
    whatsnew_mirror.py --print-digest        # fingerprint of the notes only
    whatsnew_mirror.py --releases-json releases.json --out ...   # offline input

GH_TOKEN / GITHUB_TOKEN (optional) authenticates the API calls.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable, Optional

# 2: index.json lists products; each product's notes are in <product>.json.
# (1 had the app + firmware notes inline in index.json.)
SCHEMA = 2
DEFAULT_REPO = "fughilli/splanc"


@dataclass(frozen=True)
class Product:
    """One release stream: every ``<prefix>X.Y.Z`` tag."""

    id: str  # file name + the app's key; [a-z0-9-]
    name: str  # the card's product dropdown
    label: str  # release headings: "<label> 1.2.3"
    prefix: str  # tag prefix, up to the version number

    @property
    def pattern(self) -> re.Pattern:
        return re.compile("^" + re.escape(self.prefix) + r"(\d+)\.(\d+)\.(\d+)$")


# The card's product dropdown, in this order. The first is the app itself (the
# --up-to tag and the post-update sparkle are about it).
PRODUCTS = (
    Product("app", "Splanc app", "Splanc", "app-v"),
    Product("firmware", "Firmware", "Firmware", "firmware-v"),
    Product("bridge", "Bridge", "Bridge", "pi-bridge-v"),
)
APP = PRODUCTS[0]
APP_TAG = APP.pattern
FIRMWARE_TAG = PRODUCTS[1].pattern

# Per-file and per-run download caps: a runaway asset must not bloat the site.
MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_TOTAL_MEDIA_BYTES = 150 * 1024 * 1024

# Feature-preview clips (tools/release_clips/github_release.py writes both).
CLIPS_MANIFEST = "preview-clips.json"
CLIPS_HEADING = "Feature previews"
MAX_CLIPS = 12
ASSET_API = re.compile(r"^https://api\.github\.com/repos/[^/]+/[^/]+/releases/assets/\d+$")

# -- sanitizer allowlist ------------------------------------------------------

# Tags kept as-is (attributes filtered by ALLOWED_ATTRS).
ALLOWED_TAGS = {
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "a",
    "img",
    "video",
    "details",
    "summary",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "del",
    "sup",
    "sub",
    "kbd",
}
# Renamed to their canonical allowed form.
TAG_ALIASES = {"b": "strong", "i": "em", "s": "del", "strike": "del"}
# Dropped together with everything inside them.
DROP_WITH_CONTENT = {
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "form",
    "button",
    "textarea",
    "select",
    "template",
    "noscript",
    "head",
    "title",
    "link",
    "meta",
    "base",
    "frame",
    "frameset",
    "canvas",
    "audio",
    "source",
    "track",
}
# Void elements (no end tag).
VOID = {"br", "hr", "img", "input", "source", "track", "meta", "link", "base", "wbr", "col"}
# Any other tag (div, span, picture, g-emoji, ...) is unwrapped: its children stay.

ALLOWED_ATTRS = {
    "a": {"href"},
    "img": {"src", "alt", "width", "height"},
    "video": {"src", "poster", "width", "height", "controls", "muted", "loop", "playsinline"},
    "ol": {"start"},
    "details": {"open"},
}
BOOLEAN_ATTRS = {"controls", "muted", "loop", "playsinline", "open"}
NUMERIC_ATTRS = {"width", "height", "start"}
MEDIA_ATTRS = {("img", "src"), ("video", "src"), ("video", "poster")}
# Containers whose whitespace-only text is layout noise.
NO_TEXT_PARENTS = {"ul", "ol", "table", "thead", "tbody", "tr"}
BLOCK_TAGS = {
    "p",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "pre",
    "blockquote",
    "video",
    "details",
    "summary",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
}
LINK_SCHEMES = {"http", "https", "mailto"}

MEDIA_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}
EXT_TYPES = {ext: ctype for ctype, ext in MEDIA_EXT.items()}
EXT_TYPES[".jpeg"] = "image/jpeg"


def _safe_link(href: str) -> Optional[str]:
    href = href.strip()
    try:
        scheme = urllib.parse.urlsplit(href).scheme.lower()
    except ValueError:
        return None
    return href if scheme in LINK_SCHEMES else None


def _remote_media(src: str) -> Optional[str]:
    """An http(s) media URL the mirror may download (anything else is dropped)."""
    src = src.strip()
    try:
        parts = urllib.parse.urlsplit(src)
    except ValueError:
        return None
    return src if parts.scheme in ("http", "https") and parts.netloc else None


class _TreeBuilder(HTMLParser):
    """HTML -> allowlisted JSON node tree. Media URLs are recorded, not fetched."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root: list = []
        # Stack of (tag, children-list, node-or-None). Unwrapped tags push a frame
        # whose children list IS the parent's, so their content lands in the parent.
        self.stack: list[tuple[str, list, Optional[dict]]] = []
        self.skip_depth = 0
        self.skip_tag: Optional[str] = None
        self.media: list[str] = []

    # The nearest real (kept) element's tag, or None at the root.
    def _parent_tag(self) -> Optional[str]:
        for tag, _children, node in reversed(self.stack):
            if node is not None:
                return node["t"]
        return None

    def _children(self) -> list:
        return self.stack[-1][1] if self.stack else self.root

    def _in_pre(self) -> bool:
        return any(node is not None and node["t"] == "pre" for _t, _c, node in self.stack)

    def handle_starttag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag == self.skip_tag and tag not in VOID:
                self.skip_depth += 1
            return
        if tag in DROP_WITH_CONTENT:
            if tag not in VOID:
                self.skip_tag, self.skip_depth = tag, 1
            return
        if tag == "input":
            # GitHub task lists: <input type="checkbox" checked disabled>.
            amap = {k.lower(): v for k, v in attrs}
            if (amap.get("type") or "").lower() == "checkbox":
                self._children().append("☑ " if "checked" in amap else "☐ ")
            return
        tag = TAG_ALIASES.get(tag, tag)
        if tag not in ALLOWED_TAGS:
            if tag not in VOID:
                self.stack.append((tag, self._children(), None))
            return
        node: dict = {"t": tag}
        kept: dict = {}
        for name, value in attrs:
            name = name.lower()
            if name not in ALLOWED_ATTRS.get(tag, ()):
                continue
            if name in BOOLEAN_ATTRS:
                kept[name] = True
                continue
            if value is None:
                continue
            if name in NUMERIC_ATTRS:
                m = re.fullmatch(r"\s*(\d{1,5})(?:px)?\s*", value)
                if m:
                    kept[name] = int(m.group(1))
                continue
            if (tag, name) in MEDIA_ATTRS:
                url = _remote_media(value)
                if url:
                    kept[name] = url
                    self.media.append(url)
                continue
            if tag == "a" and name == "href":
                link = _safe_link(value)
                if link:
                    kept[name] = link
                continue
            kept[name] = value
        if tag in ("img", "video") and "src" not in kept:
            return  # media with no usable source
        if kept:
            node["a"] = kept
        self._children().append(node)
        if tag not in VOID:
            node["c"] = []
            self.stack.append((tag, node["c"], node))

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag == self.skip_tag:
                self.skip_depth -= 1
                if not self.skip_depth:
                    self.skip_tag = None
            return
        tag = TAG_ALIASES.get(tag, tag)
        # Pop to the matching open tag; an unmatched end tag is ignored.
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data: str) -> None:
        if self.skip_depth or not data:
            return
        children = self._children()
        prev = children[-1] if children else None
        if not self._in_pre():
            if not data.strip():
                # Layout whitespace between blocks (or at a list/table level) is
                # noise; between inline runs it is a word space.
                if self._parent_tag() in NO_TEXT_PARENTS or prev is None:
                    return
                if isinstance(prev, dict) and prev["t"] in BLOCK_TAGS:
                    return
                data = " "
            if isinstance(prev, str) and prev[-1:].isspace():
                data = data.lstrip()
                if not data:
                    return
        if isinstance(prev, str):
            children[-1] += data
        else:
            children.append(data)


def _tidy(nodes: list) -> list:
    """Post-pass: drop empty inline wrappers, unwrap a link around a lone image
    (GitHub wraps every image in a link to its full-size URL), strip edge spaces."""
    out: list = []
    for n in nodes:
        if isinstance(n, str):
            out.append(n)
            continue
        if "c" in n:
            n["c"] = _tidy(n["c"])
            if not n["c"]:
                del n["c"]
        kids = n.get("c", [])
        if n["t"] == "a" and "href" not in n.get("a", {}):
            out.extend(kids)  # an unsafe/missing href: keep the text, drop the link
            continue
        if n["t"] == "a":
            real = [k for k in kids if not (isinstance(k, str) and not k.strip())]
            if len(real) == 1 and isinstance(real[0], dict) and real[0]["t"] in ("img", "video"):
                out.append(real[0])
                continue
        if n["t"] == "details":
            # GitHub shows an uploaded video as <details><summary>file.mp4</summary>
            # <video>; the file name is noise in the card, keep just the player.
            vids = [k for k in kids if isinstance(k, dict) and k["t"] == "video"]
            rest = [k for k in kids if not (isinstance(k, dict) and k["t"] in ("video", "summary"))]
            if vids and not [k for k in rest if not (isinstance(k, str) and not k.strip())]:
                out.extend(vids)
                continue
        if (
            n["t"] in ("strong", "em", "code", "del", "a", "p", "li", "sup", "sub", "kbd")
            and not kids
        ):
            continue
        out.append(n)
    merged: list = []
    for n in out:  # unwrapping can leave adjacent text runs
        if isinstance(n, str) and merged and isinstance(merged[-1], str):
            merged[-1] += n
        else:
            merged.append(n)
    return merged


def _urls_in(nodes: list) -> set:
    """Media URLs still referenced by a node tree (img/video src + poster)."""
    out: set = set()
    for n in nodes:
        if isinstance(n, dict):
            a = n.get("a", {})
            if n["t"] in ("img", "video"):
                out.update(a[k] for k in ("src", "poster") if isinstance(a.get(k), str))
            out |= _urls_in(n.get("c", []))
    return out


def html_to_nodes(html: str) -> tuple[list, list[str]]:
    """Sanitize rendered release HTML into (nodes, remote media URLs)."""
    b = _TreeBuilder()
    b.feed(html or "")
    b.close()
    return _tidy(b.root), b.media


def text_to_nodes(text: str) -> list:
    """Fallback when there is no body_html: paragraphs of plain text."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    return [{"t": "p", "c": [p]} for p in paras]


def rewrite_media(nodes: list, mapping: dict[str, Optional[str]]) -> list:
    """Point media at their local copies. A media node whose download failed
    (mapping value None) becomes a plain link to the original instead."""
    out: list = []
    for n in nodes:
        if isinstance(n, str):
            out.append(n)
            continue
        if "c" in n:
            n["c"] = rewrite_media(n["c"], mapping)
        a = n.get("a", {})
        if n["t"] in ("img", "video"):
            local = mapping.get(a.get("src", ""))
            if not local:
                label = a.get("alt") or ("Video" if n["t"] == "video" else "Image")
                out.append({"t": "a", "a": {"href": a.get("src", "")}, "c": [label]})
                continue
            a["src"] = local
            if "poster" in a:
                poster = mapping.get(a["poster"])
                if poster:
                    a["poster"] = poster
                else:
                    del a["poster"]
        out.append(n)
    return out


# -- release selection --------------------------------------------------------


def _version(tag: str, pattern: re.Pattern) -> Optional[tuple[int, int, int]]:
    m = pattern.match(tag or "")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def select_releases(
    releases: list[dict],
    pattern: re.Pattern,
    limit: int = 0,
    up_to: Optional[str] = None,
) -> list[dict]:
    """Published releases matching ``pattern``, newest version first (the API is
    not version-ordered), optionally capped at the ``up_to`` tag's version and
    at ``limit`` releases (0: all). The ``up_to`` release itself may still be a
    draft: the Release workflow mirrors it before publishing it with its assets."""
    cap = _version(up_to, pattern) if up_to else None
    picked = []
    for r in releases:
        v = _version(r.get("tag_name", ""), pattern)
        if v is None or (r.get("draft") and r.get("tag_name") != up_to):
            continue
        if cap is not None and v > cap:
            continue
        picked.append((v, r))
    picked.sort(key=lambda p: p[0], reverse=True)
    rows = [r for _v, r in picked]
    return rows[:limit] if limit > 0 else rows


def select_all(
    releases: list[dict], limit: int = 0, up_to: Optional[str] = None
) -> list[tuple[Product, list[dict]]]:
    """Each product's releases, in PRODUCTS order (products with none are left
    out). ``up_to`` is an app tag (a pinned or just-tagged build): app releases
    past it are left out, and so are other products' releases published after
    it went out — they are not yet news for that build."""
    app = select_releases(releases, APP.pattern, limit, up_to)
    cutoff = (app[0].get("published_at") or "") if up_to and app else ""
    out: list[tuple[Product, list[dict]]] = [(APP, app)] if app else []
    for product in PRODUCTS[1:]:
        rows = select_releases(releases, product.pattern, limit)
        if cutoff:
            rows = [r for r in rows if (r.get("published_at") or "") <= cutoff]
        if rows:
            out.append((product, rows))
    return out


def _is_media_asset(asset: dict) -> bool:
    ctype = (asset.get("content_type") or "").lower()
    if ctype.startswith("image/") or ctype.startswith("video/"):
        return True
    return os.path.splitext(asset.get("name", ""))[1].lower() in EXT_TYPES


def digest(selected: list[tuple[Product, list[dict]]]) -> str:
    """Fingerprint of everything the card shows: products, tags, markdown bodies
    and media assets. A deploy compares it with the live index.json's to
    re-mirror edits."""
    parts: list = [SCHEMA]
    for product, rows in selected:
        parts.append([product.id, product.name, product.label])
        parts.extend(_digest_part(r) for r in rows)
    blob = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(blob.encode()).hexdigest()


def _digest_part(r: dict) -> list:
    assets = sorted(
        (a.get("id"), a.get("name"), a.get("updated_at"))
        for a in r.get("assets", [])
        if _is_media_asset(a) or a.get("name") == CLIPS_MANIFEST
    )
    return [r.get("tag_name"), r.get("name"), r.get("body") or "", assets]


# -- network ------------------------------------------------------------------

Fetcher = Callable[[str], tuple[bytes, str]]


def http_fetcher(token: Optional[str]) -> Fetcher:
    def fetch(url: str) -> tuple[bytes, str]:
        headers = {"User-Agent": "splanc-whatsnew-mirror"}
        host = urllib.parse.urlsplit(url).netloc.lower()
        if host == "api.github.com":
            headers["Accept"] = "application/vnd.github.full+json"
            if token:
                headers["Authorization"] = f"Bearer {token}"
        if ASSET_API.match(url):
            # A draft release's asset: only the API serves it. It redirects to a
            # signed storage URL that must NOT get the token (urllib would forward it).
            headers["Accept"] = "application/octet-stream"
            loc = _asset_redirect(url, headers)
            if loc:
                url, headers = loc, {"User-Agent": headers["User-Agent"]}
        req = urllib.request.Request(url, headers=headers)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    ctype = resp.headers.get("Content-Type", "")
                    length = int(resp.headers.get("Content-Length") or 0)
                    if length > MAX_MEDIA_BYTES:
                        raise ValueError(f"{url}: {length} bytes exceeds the media cap")
                    data = resp.read(MAX_MEDIA_BYTES + 1)
                    if len(data) > MAX_MEDIA_BYTES:
                        raise ValueError(f"{url}: exceeds the media cap")
                    return data, ctype
            except urllib.error.HTTPError as e:
                # The releases list (big MAX OTA asset lists) intermittently 502s.
                if e.code < 500 or attempt == 3:
                    raise
            time.sleep(2 * (attempt + 1))
        raise AssertionError("unreachable")

    return fetch


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _asset_redirect(url: str, headers: dict) -> Optional[str]:
    """The storage URL an asset API URL redirects to (None: served directly)."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=60):
            return None
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
            return e.headers["Location"]
        raise


def list_releases(repo: str, fetch: Fetcher, pages: int = 40, per_page: int = 50) -> list[dict]:
    out: list[dict] = []
    for page in range(1, pages + 1):
        data, _ = fetch(
            f"https://api.github.com/repos/{repo}/releases?per_page={per_page}&page={page}"
        )
        batch = json.loads(data)
        out.extend(batch)
        if len(batch) < per_page:
            break
    return out


def _media_ext(url: str, ctype: str) -> Optional[str]:
    ctype = ctype.split(";")[0].strip().lower()
    if ctype in MEDIA_EXT:
        return MEDIA_EXT[ctype]
    ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
    if ext in EXT_TYPES and (
        not ctype or ctype in ("application/octet-stream", "binary/octet-stream")
    ):
        return ".jpg" if ext == ".jpeg" else ext
    return None


class MediaStore:
    """Downloads each media URL once into <out>/media/<sha>.<ext>."""

    def __init__(self, out_dir: str, fetch: Fetcher, log: Callable[[str], None]) -> None:
        self.dir = os.path.join(out_dir, "media")
        self.fetch = fetch
        self.log = log
        self.cache: dict[str, Optional[str]] = {}
        self.total = 0

    def get(self, url: str) -> Optional[str]:
        if url in self.cache:
            return self.cache[url]
        local: Optional[str] = None
        try:
            data, ctype = self.fetch(url)
            ext = _media_ext(url, ctype)
            if ext is None:
                raise ValueError(f"not an image/video ({ctype or 'no content type'})")
            if self.total + len(data) > MAX_TOTAL_MEDIA_BYTES:
                raise ValueError("total media cap reached")
            name = hashlib.sha256(data).hexdigest()[:20] + ext
            os.makedirs(self.dir, exist_ok=True)
            with open(os.path.join(self.dir, name), "wb") as f:
                f.write(data)
            self.total += len(data)
            local = "media/" + name
        except (urllib.error.URLError, OSError, ValueError) as e:
            self.log(f"whatsnew: skipping media {url}: {e}")
        self.cache[url] = local
        return local


def _asset_url(release: dict, asset: dict) -> Optional[str]:
    """Where to download an asset: a draft's has no public URL yet (the Release
    workflow mirrors before publishing), so it goes through the API."""
    if release.get("draft") and asset.get("url"):
        return asset["url"]
    return asset.get("browser_download_url")


def _text(n) -> str:
    if isinstance(n, str):
        return n
    return "".join(_text(k) for k in n.get("c", []))


def drop_section(nodes: list, heading: str) -> list:
    """Remove a top-level h1/h2 section titled `heading` (up to the next h1/h2)."""
    out, skipping = [], False
    for n in nodes:
        is_head = isinstance(n, dict) and n["t"] in ("h1", "h2")
        if is_head:
            skipping = _text(n).strip() == heading
        if not skipping:
            out.append(n)
    while out and isinstance(out[0], str) and not out[0].strip():
        out.pop(0)
    return out


def mirror_clips(
    release: dict, media: MediaStore, fetch: Fetcher, log: Callable[[str], None]
) -> tuple[list, set]:
    """(clips for the card, asset names they use) from the release's
    preview-clips.json. Media are downloaded like any other; a clip whose MP4
    fails to download is dropped. Best effort: a bad manifest means no clips."""
    assets = {a.get("name"): a for a in release.get("assets", [])}
    man = assets.get(CLIPS_MANIFEST)
    if not man:
        return [], set()
    try:
        data, _ = fetch(_asset_url(release, man) or "")
        manifest = json.loads(data)
        rows = manifest["clips"]
        assert isinstance(rows, list)
    except Exception as e:
        log(f"whatsnew: {release.get('tag_name')}: unreadable {CLIPS_MANIFEST}: {e}")
        return [], {CLIPS_MANIFEST}
    used = {CLIPS_MANIFEST}
    clips = []
    for c in rows[:MAX_CLIPS]:
        if not isinstance(c, dict):
            continue
        variants = []
        for v in c.get("variants") or []:
            if not isinstance(v, dict) or v.get("framing") not in ("phone", "desktop"):
                continue
            names = [v.get(k) for k in ("mp4", "webm", "poster", "gif")]
            used.update(n for n in names if isinstance(n, str))
            local = {}
            for k in ("mp4", "webm", "poster"):
                a = assets.get(v.get(k))
                url = _asset_url(release, a) if a else None
                if url:
                    got = media.get(url)
                    if got:
                        local[k] = got
            if "mp4" not in local:
                continue
            out_v = {"framing": v["framing"], **local}
            for k in ("width", "height"):
                if isinstance(v.get(k), int) and 0 < v[k] < 10000:
                    out_v[k] = v[k]
            variants.append(out_v)
        title, summary = c.get("title"), c.get("summary")
        if not variants or not isinstance(title, str) or not isinstance(summary, str):
            continue
        prs = [n for n in c.get("prs") or [] if isinstance(n, int)]
        clips.append({"id": str(c.get("id", ""))[:48], "title": title[:80], "summary": summary[:300],
                      "prs": prs, "variants": variants})  # fmt: skip
    return clips, used


def mirror_release(
    release: dict,
    version_re: re.Pattern,
    media: MediaStore,
    repo: str,
    fetch: Optional[Fetcher] = None,
    log: Callable[[str], None] = lambda m: None,
) -> dict:
    html = release.get("body_html")
    if html is None:
        nodes, urls = text_to_nodes(release.get("body") or ""), []
    else:
        nodes, urls = html_to_nodes(html)
    clips, clip_assets = mirror_clips(release, media, fetch or media.fetch, log)
    if clips:
        # The GIF section is GitHub's rendering of the clips; the card plays the MP4s.
        nodes = drop_section(nodes, CLIPS_HEADING)
        clip_urls = {
            a.get("browser_download_url")
            for a in release.get("assets", [])
            if a.get("name") in clip_assets
        }
        urls = [u for u in urls if u in _urls_in(nodes) and u not in clip_urls]
    referenced = set(urls)
    # Image/video assets not shown in the body: append them as a gallery.
    for asset in release.get("assets", []):
        if asset.get("name") in clip_assets:
            continue
        if asset.get("browser_download_url") in referenced or not _is_media_asset(asset):
            continue
        url = _asset_url(release, asset)
        if not url:
            continue
        ctype = (asset.get("content_type") or "").lower()
        ext = os.path.splitext(asset.get("name", ""))[1].lower()
        is_video = ctype.startswith("video/") or EXT_TYPES.get(ext, "").startswith("video/")
        alt = os.path.splitext(asset.get("name", ""))[0].replace("-", " ").replace("_", " ")
        node = (
            {"t": "video", "a": {"src": url, "controls": True, "muted": True, "playsinline": True}}
            if is_video
            else {"t": "img", "a": {"src": url, "alt": alt}}
        )
        nodes.append({"t": "p", "c": [node]})
        urls.append(url)
    # A draft's notes link its assets by their future public URL; fetch those
    # through the API too.
    alias = {}
    if release.get("draft"):
        for a in release.get("assets", []):
            if a.get("url"):
                alias[
                    f"https://github.com/{repo}/releases/download/{release['tag_name']}/{a.get('name')}"
                ] = a["url"]
                if a.get("browser_download_url"):
                    alias[a["browser_download_url"]] = a["url"]
    mapping = {u: media.get(alias.get(u, u)) for u in urls}
    nodes = rewrite_media(nodes, mapping)
    v = _version(release["tag_name"], version_re)
    assert v is not None
    used = sorted(
        {p for p in mapping.values() if p}
        | {
            x
            for c in clips
            for vv in c["variants"]
            for k, x in vv.items()
            if k in ("mp4", "webm", "poster")
        }
    )
    return {
        "version": "%d.%d.%d" % v,
        "tag": release["tag_name"],
        "name": release.get("name") or release["tag_name"],
        "date": release.get("published_at") or release.get("created_at"),
        # Not html_url: a draft's is an "untagged-..." link that dies on publish.
        "url": f"https://github.com/{repo}/releases/tag/{release['tag_name']}",
        "prerelease": bool(release.get("prerelease")),
        "body": nodes,
        "media": used,
        **({"clips": clips} if clips else {}),
    }


def build_index(
    releases: list[dict],
    out_dir: str,
    fetch: Fetcher,
    *,
    repo: str = DEFAULT_REPO,
    limit: int = 0,
    up_to: Optional[str] = None,
    now: Optional[str] = None,
    log: Callable[[str], None] = lambda m: print(m, file=sys.stderr),
) -> dict:
    """Write <out_dir>/index.json, one <product>.json per product with releases,
    and media/ from a releases list. Replaces whatever was in out_dir. Returns
    the index with each product's file contents under "notes" (not written to
    index.json; handy for callers and tests)."""
    selected = select_all(releases, limit, up_to)
    parent = os.path.dirname(os.path.abspath(out_dir)) or "."
    os.makedirs(parent, exist_ok=True)
    work = tempfile.mkdtemp(prefix=".whatsnew-", dir=parent)
    try:
        media = MediaStore(work, fetch, log)
        products = []
        notes: dict[str, dict] = {}
        for product, rows in selected:
            mirrored = [mirror_release(r, product.pattern, media, repo, fetch, log) for r in rows]
            body = {"schema": SCHEMA, "product": product.id, "releases": mirrored}
            _write_json(os.path.join(work, product.id + ".json"), body)
            notes[product.id] = body
            newest = mirrored[0]
            products.append(
                {
                    "id": product.id,
                    "name": product.name,
                    "label": product.label,
                    "file": product.id + ".json",
                    "count": len(mirrored),
                    "latest": {"version": newest["version"], "date": newest["date"]},
                }
            )
        index = {
            "schema": SCHEMA,
            "repo": repo,
            "generated_at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "digest": digest(selected),
            "products": products,
        }
        _write_json(os.path.join(work, "index.json"), index)
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        os.replace(work, out_dir)
        os.chmod(out_dir, 0o755)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return {**index, "notes": notes}


def _write_json(path: str, obj: dict) -> None:
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", default=os.environ.get("WHATSNEW_REPO", DEFAULT_REPO))
    ap.add_argument("--out", help="output directory (replaced), e.g. _site/whatsnew")
    ap.add_argument("--up-to", help="newest app tag to include (the build's own tag)")
    ap.add_argument(
        "--limit", type=int, default=0, help="releases to keep per product (default 0: all)"
    )
    ap.add_argument("--releases-json", help="read the releases list from this file (offline)")
    ap.add_argument(
        "--print-digest",
        action="store_true",
        help="print the notes fingerprint and exit (no downloads, nothing written)",
    )
    args = ap.parse_args(argv)
    if args.up_to and not APP_TAG.match(args.up_to):
        args.up_to = None  # a non-release build (main, PR): include everything
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    fetch = http_fetcher(token)
    if args.releases_json:
        with open(args.releases_json) as f:
            releases = json.load(f)
    else:
        releases = list_releases(args.repo, fetch)
    if args.print_digest:
        print(digest(select_all(releases, args.limit, args.up_to)))
        return 0
    if not args.out:
        ap.error("--out is required unless --print-digest")
    index = build_index(
        releases, args.out, fetch, repo=args.repo, limit=args.limit, up_to=args.up_to
    )
    rows = [r for body in index["notes"].values() for r in body["releases"]]
    n_media = len({m for r in rows for m in r["media"]})
    counts = ", ".join(f"{p['count']} {p['id']}" for p in index["products"]) or "no"
    print(
        f"whatsnew: {counts} release(s), {n_media} media file(s) -> {args.out} "
        f"({index['digest'][:19]})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
