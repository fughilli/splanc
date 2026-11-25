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

While the release is a draft, its assets are served only under the draft's
placeholder tag (``/releases/download/untagged-<id>/``, for people who can see the
draft), and the final ``/releases/download/<tag>/`` URLs don't exist yet. So a
draft's section links the placeholder URLs, which work during review, and
``relink`` rewrites them to the final ones once the Release workflow publishes it.
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
# A draft's placeholder tag, as GitHub puts it in the draft's html_url and asset URLs.
UNTAGGED_RE = re.compile(r"untagged-[0-9a-f]+")


def download_base(repo: str, tag: str) -> str:
    return f"https://github.com/{repo}/releases/download/{tag}/"


def release_download_base(release: dict, repo: str, tag: str) -> str:
    """Where `release`'s assets download from now: a draft's placeholder tag
    (from its html_url, ``.../releases/tag/untagged-<id>``), else `tag`."""
    if release.get("draft"):
        m = UNTAGGED_RE.search(release.get("html_url") or "")
        if m:
            return download_base(repo, m.group(0))
    return download_base(repo, tag)


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


def section_markdown(manifest: dict, repo: str, base: Optional[str] = None) -> str:
    """The body section: one GIF (phone framing first) per clip, linking the MP4.
    `base` is where the assets download from (default: the final tag URL)."""
    tag = manifest["tag"]
    if not manifest["clips"]:
        return ""
    base = base or download_base(repo, tag)

    def url(name: str) -> str:
        return base + urllib.parse.quote(name)

    out = [START, f"## {HEADING}", ""]
    for c in manifest["clips"]:
        vs = sorted(c["variants"], key=lambda v: v["framing"] != "phone")
        main = vs[0]
        width = 280 if main["framing"] == "phone" else 560
        prs = " ".join(f"#{n}" for n in c["prs"])
        out.append(f"### {c['title']}")
        out.append("")
        out.append(
            f'<a href="{url(main["mp4"])}">'
            f'<img src="{url(main["gif"])}" alt="{_attr(c["title"])}" width="{width}"></a>'
        )
        out.append("")
        links = " · ".join(f"[{v['framing']} video (MP4)]({url(v['mp4'])})" for v in vs)
        out.append(f"{c['summary']}{' (' + prs + ')' if prs else ''} · {links}")
        out.append("")
    out.append(END)
    return "\n".join(out) + "\n\n"


def _attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def pick_release(rows: list[dict], tag: str) -> Optional[dict]:
    """The published release for `tag`, else its newest draft. A draft is matched
    by its name too: GitHub reports a draft's tag as ``untagged-<id>`` once
    another release (another draft, say) claims the same tag, and every draft
    the Release workflow makes is named after its tag."""
    for r in rows:
        if not r.get("draft") and r.get("tag_name") == tag:
            return r
    drafts = [r for r in rows if r.get("draft") and tag in (r.get("tag_name"), r.get("name"))]
    drafts.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return drafts[0] if drafts else None


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

    def releases(self) -> list[dict]:
        out: list[dict] = []
        for page in range(1, 6):
            rows = self._req("GET", f"/releases?per_page=100&page={page}") or []
            out += rows
            if len(rows) < 100:
                break
        return out

    def release_for_tag(self, tag: str) -> Optional[dict]:
        """The release for `tag` (see `pick_release`). Drafts are not visible
        through /releases/tags/<tag>, so list them."""
        return pick_release(self.releases(), tag)

    def create_release(self, fields: dict) -> dict:
        return self._req("POST", "/releases", json.dumps(fields).encode())

    def update_release(self, release: dict, fields: dict) -> dict:
        return self._req("PATCH", f"/releases/{release['id']}", json.dumps(fields).encode())

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
    base = release_download_base(release, gh.repo, tag)
    body = splice_body(release.get("body") or "", section_markdown(manifest, gh.repo, base))
    gh.update_body(release, body)
    log(
        f"release_clips: {len(manifest['clips'])} clip(s) on {tag} ({'draft' if release.get('draft') else 'published'})"
    )
    return manifest


def relink_body(body: str, repo: str, tag: str) -> str:
    """`body` with every draft placeholder download URL pointed at `tag`'s."""
    pat = re.compile(
        re.escape(f"https://github.com/{repo}/releases/download/") + UNTAGGED_RE.pattern + "/"
    )
    return pat.sub(download_base(repo, tag), body or "")


def relink(gh: GitHub, tag: str, log=print) -> bool:
    """After the draft is published: point its notes' asset links at the final
    tag URLs (the placeholder ones stop working). Returns whether it changed."""
    release = gh.release_for_tag(tag)
    if release is None:
        raise SystemExit(f"release_clips: no release for {tag}")
    if release.get("draft"):
        log(f"release_clips: {tag} is still a draft; its links stay on the draft's URLs")
        return False
    body = release.get("body") or ""
    new = relink_body(body, gh.repo, tag)
    if new == body:
        log(f"release_clips: {tag}'s notes already link the final URLs")
        return False
    gh.update_body(release, new)
    log(f"release_clips: {tag}'s notes now link /releases/download/{tag}/")
    return True


def ensure_draft(gh: GitHub, tag: str, target: str, log=print) -> dict:
    """The release `tag` will ship as: the existing draft (or published release)
    for it, else a new draft with generated notes. Notes written on an existing
    draft beforehand are kept."""
    release = gh.release_for_tag(tag)
    if release is not None:
        kind = "draft" if release.get("draft") else "release"
        log(f"release_clips: using the existing {kind} for {tag} ({release['id']})")
        return release
    release = gh.create_release(
        {
            "tag_name": tag,
            "target_commitish": target,
            "name": tag,
            "draft": True,
            "generate_release_notes": True,
            "make_latest": "false",
        }
    )
    log(f"release_clips: created the draft for {tag} ({release['id']})")
    return release


def finalize(gh: GitHub, tag: str, files: list[str], log=print) -> dict:
    """Attach `files` (replacing same-named assets) to `tag`'s draft, publish it
    under `tag` (notes as they are; never marked latest), then relink its notes."""
    release = gh.release_for_tag(tag)
    if release is None:
        raise SystemExit(f"release_clips: no draft or release for {tag}")
    existing = {a["name"]: a for a in release.get("assets", [])}
    for path in files:
        name = os.path.basename(path)
        if name in existing:
            gh.delete_asset(existing[name]["id"])
        gh.upload_asset(release, path, name)
        log(f"release_clips: uploaded {name}")
    if release.get("draft"):
        release = gh.update_release(
            release, {"draft": False, "tag_name": tag, "make_latest": "false"}
        )
        log(f"release_clips: published {tag} ({release['id']})")
    relink(gh, tag, log=log)
    return release
