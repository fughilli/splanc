"""Which user-visible features shipped between two app releases, and which clip
scripts show them.

The range is ``<previous app-v tag>..<ref>`` on the first-parent history (main
squash-merges PRs, so each first-parent commit is one PR, "(#123)" in its
subject). A PR is user-visible when it touches the app's source (``web/src``
outside tests and the demo seam, ``web/public``, ``web/index.html``, the iOS
shell) or carries an ``app``/``ui`` label; a ``no-clip`` label opts it out.

A clip script is in the release when the script itself changed in the range
(the feature PR added or updated it) or when it lists one of the range's PRs in
``prs``. User-visible PRs with no clip are "uncovered": the agent fallback can
draft a script for them (``release_clips.py draft``).
"""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

from clipspec import SUFFIX, ClipSpec

APP_TAG = re.compile(r"^app-v(\d+)\.(\d+)\.(\d+)$")
PR_IN_SUBJECT = re.compile(r"\(#(\d+)\)\s*$|^Merge pull request #(\d+)")

USER_VISIBLE = (
    "web/src/*",
    "web/public/*",
    "web/index.html",
    "ios/*",
)
NOT_USER_VISIBLE = (
    "web/src/demo/*",
    "web/src/**/*.test.ts",
    "web/tests/*",
    "*" + SUFFIX,
    "*.md",
)
VISIBLE_LABELS = {"app", "ui", "web"}
SKIP_LABEL = "no-clip"


@dataclass
class PullRequest:
    number: int
    title: str
    sha: str
    files: list[str]
    body: str = ""
    labels: list[str] = field(default_factory=list)
    url: str = ""

    @property
    def visible_files(self) -> list[str]:
        return [f for f in self.files if is_user_visible(f)]

    @property
    def user_visible(self) -> bool:
        if SKIP_LABEL in self.labels:
            return False
        return bool(self.visible_files) or bool(VISIBLE_LABELS & set(self.labels))


def is_user_visible(path: str) -> bool:
    if any(fnmatch.fnmatch(path, p) for p in NOT_USER_VISIBLE):
        return False
    return any(fnmatch.fnmatch(path, p) for p in USER_VISIBLE)


def _git(repo: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True, text=True
    ).stdout


def _ver(tag: str) -> Optional[tuple[int, int, int]]:
    m = APP_TAG.match(tag)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def previous_app_tag(tags: list[str], tag: Optional[str]) -> Optional[str]:
    """The newest app-v tag below `tag` (or the newest overall when `tag` is
    None / not a release tag: planning a release that isn't tagged yet)."""
    vs = sorted((v, t) for t in tags if (v := _ver(t)))
    cur = _ver(tag) if tag else None
    older = [t for v, t in vs if cur is None or v < cur]
    return older[-1] if older else None


def range_commits(repo: str, since: Optional[str], ref: str) -> list[tuple[str, str]]:
    spec = f"{since}..{ref}" if since else ref
    out = _git(repo, "log", "--first-parent", "--format=%H%x1f%s", spec)
    rows = []
    for line in out.splitlines():
        if "\x1f" in line:
            sha, subject = line.split("\x1f", 1)
            rows.append((sha, subject))
    return rows


def commit_files(repo: str, sha: str) -> list[str]:
    out = _git(repo, "diff", "--name-only", f"{sha}^1", sha)
    return [x for x in out.splitlines() if x]


def pr_number(subject: str) -> Optional[int]:
    m = PR_IN_SUBJECT.search(subject)
    if not m:
        return None
    return int(m[1] or m[2])


def github_pr_fetcher(repo_slug: str, token: Optional[str]) -> Callable[[int], dict]:
    def fetch(n: int) -> dict:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo_slug}/pulls/{n}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "splanc-release-clips",
                **({"Authorization": f"Bearer {token}"} if token else {}),
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    return fetch


def collect_prs(
    repo: str,
    since: Optional[str],
    ref: str,
    fetch_pr: Optional[Callable[[int], dict]] = None,
    log: Callable[[str], None] = lambda m: None,
) -> list[PullRequest]:
    prs = []
    for sha, subject in range_commits(repo, since, ref):
        n = pr_number(subject)
        if n is None:
            continue  # direct pushes (data refreshes, [skip ci] bots)
        title = re.sub(r"\s*\(#\d+\)\s*$", "", subject)
        pr = PullRequest(number=n, title=title, sha=sha, files=commit_files(repo, sha))
        if fetch_pr is not None:
            try:
                meta = fetch_pr(n)
                pr.title = meta.get("title") or pr.title
                pr.body = meta.get("body") or ""
                pr.labels = [lb["name"] for lb in meta.get("labels", []) if "name" in lb]
                pr.url = meta.get("html_url") or ""
            except Exception as e:  # the plan still works from git alone
                log(f"release_clips: PR #{n} metadata unavailable: {e}")
        prs.append(pr)
    return prs


@dataclass
class Plan:
    tag: Optional[str]
    since: Optional[str]
    ref: str
    prs: list[PullRequest]
    clips: list[ClipSpec]
    clip_prs: dict[str, list[int]]
    uncovered: list[PullRequest]

    def to_json(self) -> dict:
        return {
            "tag": self.tag,
            "since": self.since,
            "ref": self.ref,
            "clips": [{**c.to_json(), "release_prs": self.clip_prs[c.id]} for c in self.clips],
            "prs": [
                {
                    "number": p.number,
                    "title": p.title,
                    "user_visible": p.user_visible,
                    "labels": p.labels,
                    "clips": [cid for cid, ns in self.clip_prs.items() if p.number in ns],
                }
                for p in self.prs
            ],
            "uncovered": [{"number": p.number, "title": p.title} for p in self.uncovered],
        }


def make_plan(
    specs: list[ClipSpec],
    prs: list[PullRequest],
    tag: Optional[str],
    since: Optional[str],
    ref: str,
) -> Plan:
    by_path = {s.path: s for s in specs}
    clip_prs: dict[str, list[int]] = {}
    for pr in prs:
        for f in pr.files:
            if f in by_path:
                clip_prs.setdefault(by_path[f].id, []).append(pr.number)
        for s in specs:
            if pr.number in s.prs and pr.number not in clip_prs.get(s.id, []):
                clip_prs.setdefault(s.id, []).append(pr.number)
    chosen = [s for s in specs if s.id in clip_prs]
    covered = {n for ns in clip_prs.values() for n in ns}
    uncovered = [p for p in prs if p.user_visible and p.number not in covered]
    return Plan(
        tag, since, ref, prs, chosen, {s.id: sorted(clip_prs[s.id]) for s in chosen}, uncovered
    )
