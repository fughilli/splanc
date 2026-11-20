"""Put recorded clips on a GitHub release (normally the draft the Release
workflow creates for an app-v* tag) and write its "Feature previews" section.

GitHub's API cannot attach a video the way a drag-and-drop upload in the release
editor does (those ``user-attachments`` uploads are browser-session only), and
release bodies strip ``<video>``. So the body shows each clip as an animated GIF
(GitHub plays those inline, with a pause control) linking to the MP4 asset. The
app does not use the GIF: the mirror reads ``preview-clips.json`` and plays the
MP4 inline (tools/whatsnew/whatsnew_mirror.py).

The section sits between HTML comment markers, so re-running replaces it and
leaves hand-written notes alone.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

START = "<!-- preview-clips:start -->"
END = "<!-- preview-clips:end -->"
HEADING = "Feature previews"
MANIFEST = "preview-clips.json"
MANIFEST_SCHEMA = 1
CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".json": "application/json",
}
SECTION_RE = re.compile(re.escape(START) + r".*?" + re.escape(END) + r"\n*", re.S)


def asset_url(repo: str, tag: str, name: str) -> str:
    return f"https://github.com/{repo}/releases/download/{tag}/{urllib.parse.quote(name)}"


def clip_assets(entries: list[dict]) -> list[str]:
    """File names of every asset the clips need (+ the manifest)."""
    names = []
    for e in entries:
        for v in e.get("variants", []):
            names += [v["mp4"], v["webm"], v["gif"], v["poster"]]
    return names


def build_manifest(entries: list[dict], tag: str) -> dict:
    """What the mirror (and any other reader) needs: approved clips only, no
    local paths."""
    clips = []
    for e in entries:
        if e.get("error") or not e.get("variants"):
            continue
        clips.append(
            {
                "id": e["id"],
                "title": e["title"],
                "summary": e["summary"],
                "prs": e.get("release_prs") or e.get("prs") or [],
                "variants": [
                    {
                        k: v[k]
                        for k in (
                            "framing",
                            "mp4",
                            "webm",
                            "gif",
                            "poster",
                            "width",
                            "height",
                            "duration",
                        )
                    }
                    for v in e["variants"]
                ],
            }
        )
    return {"schema": MANIFEST_SCHEMA, "tag": tag, "clips": clips}


def section_markdown(manifest: dict, repo: str) -> str:
    """The body section: one GIF (phone framing first) per clip, linking the MP4."""
    tag = manifest["tag"]
    if not manifest["clips"]:
        return ""
    out = [START, f"## {HEADING}", ""]
    for c in manifest["clips"]:
        vs = sorted(c["variants"], key=lambda v: v["framing"] != "phone")
        main = vs[0]
        width = 280 if main["framing"] == "phone" else 560
        prs = " ".join(f"#{n}" for n in c["prs"])
        out.append(f"### {c['title']}")
        out.append("")
        out.append(
            f'<a href="{asset_url(repo, tag, main["mp4"])}">'
            f'<img src="{asset_url(repo, tag, main["gif"])}" alt="{_attr(c["title"])}" width="{width}"></a>'
        )
        out.append("")
        links = " · ".join(
            f"[{v['framing']} video (MP4)]({asset_url(repo, tag, v['mp4'])})" for v in vs
        )
        out.append(f"{c['summary']}{' (' + prs + ')' if prs else ''} · {links}")
        out.append("")
    out.append(END)
    return "\n".join(out) + "\n\n"


def _attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def splice_body(body: str, section: str) -> str:
    """Replace the marked section, or put a new one at the top (previews lead
    the notes). An empty section removes it."""
    body = body or ""
    if SECTION_RE.search(body):
        return SECTION_RE.sub(lambda _: section, body, count=1)
    return section + body if section else body


# -- the GitHub API -------------------------------------------------------------


class GitHub:
    def __init__(self, repo: str, token: str, opener: Optional[Callable] = None) -> None:
        self.repo = repo
        self.token = token
        self.open = opener or urllib.request.urlopen

    def _req(
        self, method: str, url: str, data: Optional[bytes] = None, ctype: str = "application/json"
    ):
        if not url.startswith("https://"):
            url = f"https://api.github.com/repos/{self.repo}{url}"
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", "splanc-release-clips")
        if data is not None:
            req.add_header("Content-Type", ctype)
        with self.open(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def release_for_tag(self, tag: str) -> Optional[dict]:
        """The release (draft or published) for `tag`. Drafts are not visible
        through /releases/tags/<tag>, so list them."""
        for page in range(1, 6):
            rows = self._req("GET", f"/releases?per_page=100&page={page}") or []
            for r in rows:
                if r.get("tag_name") == tag:
                    return r
            if len(rows) < 100:
                break
        return None

    def update_body(self, release: dict, body: str) -> dict:
        return self._req("PATCH", f"/releases/{release['id']}", json.dumps({"body": body}).encode())

    def delete_asset(self, asset_id: int) -> None:
        self._req("DELETE", f"/releases/assets/{asset_id}")

    def upload_asset(self, release: dict, path: str, name: Optional[str] = None) -> dict:
        name = name or os.path.basename(path)
        base = release["upload_url"].split("{", 1)[0]
        ctype = CONTENT_TYPES.get(os.path.splitext(name)[1].lower()) or (
            mimetypes.guess_type(name)[0] or "application/octet-stream"
        )
        with open(path, "rb") as f:
            data = f.read()
        return self._req("POST", f"{base}?name={urllib.parse.quote(name)}", data, ctype)


def publish(gh: GitHub, tag: str, clips_dir: str, entries: list[dict], log=print) -> dict:
    """Upload every clip file + the manifest to `tag`'s release (replacing
    same-named assets) and splice the body section. Returns the manifest."""
    release = gh.release_for_tag(tag)
    if release is None:
        raise SystemExit(f"release_clips: no release (or draft) for {tag}; create it first")
    manifest = build_manifest(entries, tag)
    man_path = os.path.join(clips_dir, MANIFEST)
    with open(man_path, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    wanted = clip_assets([e for e in entries if not e.get("error")]) + [MANIFEST]
    existing = {a["name"]: a for a in release.get("assets", [])}
    for name in wanted:
        if name in existing:
            gh.delete_asset(existing[name]["id"])
        gh.upload_asset(release, os.path.join(clips_dir, name), name)
        log(f"release_clips: uploaded {name}")
    body = splice_body(release.get("body") or "", section_markdown(manifest, gh.repo))
    gh.update_body(release, body)
    log(
        f"release_clips: {len(manifest['clips'])} clip(s) on {tag} ({'draft' if release.get('draft') else 'published'})"
    )
    return manifest
