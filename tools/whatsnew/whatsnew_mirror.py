#!/usr/bin/env python3
"""Mirror the app's GitHub release notes into the static site for the in-app
"What's new?" card.

The app never calls the GitHub API at runtime (rate limits, CORS, offline). This
tool runs at deploy time instead, in fughilli/splanc's release + site builds and
in the splanc.io deploy (Studio-Fug/splanc.io scripts/stage-app.mjs), and writes:

    <out>/index.json        the notes of the newest N app-v* releases (+ the newest
                            few firmware-v* releases), newest first
    <out>/media/<hash>.<ext> every image/video the notes show, downloaded

Release bodies come from the API's rendered ``body_html`` (exactly what GitHub
shows on the release page, so drag-and-dropped ``github.com/user-attachments``
images and videos come through). The HTML is parsed into a small JSON node tree
through a strict tag/attribute allowlist: no scripts, styles, event handlers,
iframes or forms survive, and the app builds DOM from the tree with
createElement (it never assigns innerHTML). Every media URL is downloaded and
rewritten to a local ``media/...`` path; image/video release assets that the
body doesn't reference are appended to the notes as a gallery.

Node format (``body`` of each release): a text node is a JSON string; an element
is ``{"t": tag, "a": {attr: value}, "c": [children]}`` ("a"/"c" omitted when
empty). Boolean attributes carry ``true``.

Stdlib only, so it also runs as a plain ``python3 whatsnew_mirror.py`` on a CI
runner without Bazel. Usage:

    whatsnew_mirror.py --out _site/whatsnew [--repo fughilli/splanc]
                       [--up-to app-v1.15.0] [--limit 10] [--firmware-limit 3]
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
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable, Optional

SCHEMA = 1
DEFAULT_REPO = "fughilli/splanc"
APP_TAG = re.compile(r"^app-v(\d+)\.(\d+)\.(\d+)$")
FIRMWARE_TAG = re.compile(r"^firmware-v(\d+)\.(\d+)\.(\d+)$")

# Per-file and per-run download caps: a runaway asset must not bloat the site.
MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_TOTAL_MEDIA_BYTES = 150 * 1024 * 1024

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
    limit: int,
    up_to: Optional[str] = None,
) -> list[dict]:
    """Published releases matching ``pattern``, newest version first (the API is
    not version-ordered), optionally capped at the ``up_to`` tag's version. The
    ``up_to`` release itself may still be a draft: the Release workflow mirrors
    it before publishing it with its assets."""
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
    return [r for _v, r in picked[: max(0, limit)]]


def select_all(
    releases: list[dict], limit: int, firmware_limit: int, up_to: Optional[str] = None
) -> tuple[list[dict], list[dict]]:
    """The app and firmware releases an index carries. With ``up_to`` (a pinned or
    just-tagged build), firmware published after that app release is left out:
    it is not yet news for that build."""
    app = select_releases(releases, APP_TAG, limit, up_to)
    firmware = select_releases(releases, FIRMWARE_TAG, firmware_limit)
    cutoff = (app[0].get("published_at") or "") if up_to and app else ""
    if cutoff:
        firmware = [r for r in firmware if (r.get("published_at") or "") <= cutoff]
    return app, firmware


def _is_media_asset(asset: dict) -> bool:
    ctype = (asset.get("content_type") or "").lower()
    if ctype.startswith("image/") or ctype.startswith("video/"):
        return True
    return os.path.splitext(asset.get("name", ""))[1].lower() in EXT_TYPES


def digest(app: list[dict], firmware: list[dict]) -> str:
    """Fingerprint of everything the card shows: tags, markdown bodies and media
    assets. A deploy compares it with the live index.json to re-mirror edits."""
    parts = []
    for r in app + firmware:
        assets = sorted(
            (a.get("id"), a.get("name"), a.get("updated_at"))
            for a in r.get("assets", [])
            if _is_media_asset(a)
        )
        parts.append([r.get("tag_name"), r.get("name"), r.get("body") or "", assets])
    blob = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(blob.encode()).hexdigest()


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


def list_releases(repo: str, fetch: Fetcher, pages: int = 6, per_page: int = 50) -> list[dict]:
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


def mirror_release(release: dict, version_re: re.Pattern, media: MediaStore, repo: str) -> dict:
    html = release.get("body_html")
    if html is None:
        nodes, urls = text_to_nodes(release.get("body") or ""), []
    else:
        nodes, urls = html_to_nodes(html)
    referenced = set(urls)
    # Image/video assets not shown in the body: append them as a gallery.
    for asset in release.get("assets", []):
        url = asset.get("browser_download_url")
        if not url or url in referenced or not _is_media_asset(asset):
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
    mapping = {u: media.get(u) for u in urls}
    nodes = rewrite_media(nodes, mapping)
    v = _version(release["tag_name"], version_re)
    assert v is not None
    used = sorted({p for p in mapping.values() if p})
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
    }


def build_index(
    releases: list[dict],
    out_dir: str,
    fetch: Fetcher,
    *,
    repo: str = DEFAULT_REPO,
    limit: int = 10,
    firmware_limit: int = 3,
    up_to: Optional[str] = None,
    now: Optional[str] = None,
    log: Callable[[str], None] = lambda m: print(m, file=sys.stderr),
) -> dict:
    """Write <out_dir>/index.json (+ media/) from a releases list. Replaces
    whatever was in out_dir. Returns the index."""
    app, firmware = select_all(releases, limit, firmware_limit, up_to)
    parent = os.path.dirname(os.path.abspath(out_dir)) or "."
    os.makedirs(parent, exist_ok=True)
    work = tempfile.mkdtemp(prefix=".whatsnew-", dir=parent)
    try:
        media = MediaStore(work, fetch, log)
        index = {
            "schema": SCHEMA,
            "repo": repo,
            "generated_at": now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "digest": digest(app, firmware),
            "releases": [mirror_release(r, APP_TAG, media, repo) for r in app],
            "firmware": [mirror_release(r, FIRMWARE_TAG, media, repo) for r in firmware],
        }
        with open(os.path.join(work, "index.json"), "w") as f:
            json.dump(index, f, indent=1, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)
        os.replace(work, out_dir)
        os.chmod(out_dir, 0o755)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return index


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", default=os.environ.get("WHATSNEW_REPO", DEFAULT_REPO))
    ap.add_argument("--out", help="output directory (replaced), e.g. _site/whatsnew")
    ap.add_argument("--up-to", help="newest app tag to include (the build's own tag)")
    ap.add_argument("--limit", type=int, default=10, help="app releases to keep")
    ap.add_argument("--firmware-limit", type=int, default=3, help="firmware releases to keep")
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
        print(digest(*select_all(releases, args.limit, args.firmware_limit, args.up_to)))
        return 0
    if not args.out:
        ap.error("--out is required unless --print-digest")
    index = build_index(
        releases,
        args.out,
        fetch,
        repo=args.repo,
        limit=args.limit,
        firmware_limit=args.firmware_limit,
        up_to=args.up_to,
    )
    n_media = sum(len(r["media"]) for r in index["releases"] + index["firmware"])
    print(
        f"whatsnew: {len(index['releases'])} app + {len(index['firmware'])} firmware "
        f"release(s), {n_media} media file(s) -> {args.out} ({index['digest'][:19]})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
