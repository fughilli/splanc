#!/usr/bin/env python3
"""Feature-preview clips for app releases (docs/release-clips.md).

    plan     which user-visible PRs shipped since the last app release, and which
             clip scripts (``web/src/**/<id>.clip.json``) show them
    record   record the release's clips (or --spec files) against a built app
             into an output directory: MP4 + WebM + GIF + poster per framing,
             and clips.json (the plan + one entry per clip)
    draft    agent fallback: draft a clip script for a PR that has none
    page     a self-contained review page (index.html + the clips) for an
             artifact or any static host
    publish  upload the clips + preview-clips.json to the tag's (draft)
             release and write the "Feature previews" section of its notes

Run through Bazel (``bazel run //tools/release_clips -- record ...``) so
Playwright and ffmpeg come from the lockfile, or with any python that has
``playwright`` and ``imageio-ffmpeg``.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import clipspec  # noqa: E402
import features  # noqa: E402

CLIPS_JSON = "clips.json"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def repo_dir(arg: str | None) -> str:
    return arg or os.environ.get("BUILD_WORKSPACE_DIRECTORY") or os.getcwd()


def _tags(repo: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", repo, "tag", "-l", "app-v*"], capture_output=True, text=True, check=True
    ).stdout
    return out.split()


def make_plan(args) -> features.Plan:
    repo = repo_dir(args.repo)
    specs = clipspec.load_all(repo)
    tag = args.tag
    ref = args.ref or (tag if tag and tag in _tags(repo) else "HEAD")
    since = args.since or features.previous_app_tag(_tags(repo), tag)
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    fetch = None if args.offline else features.github_pr_fetcher(args.github_repo, token)
    prs = features.collect_prs(repo, since, ref, fetch, _log)
    return features.make_plan(specs, prs, tag, since, ref)


def cmd_plan(args) -> int:
    plan = make_plan(args)
    out = plan.to_json()
    if args.json:
        print(json.dumps(out, indent=1))
        return 0
    print(f"{plan.since or '(start)'}..{plan.ref}: {len(plan.prs)} PR(s)")
    for c in plan.clips:
        prs = ", ".join(f"#{n}" for n in plan.clip_prs[c.id])
        print(f"  clip {c.id:<24} {c.title}  [{prs}]  ({c.path})")
    for p in plan.uncovered:
        print(f"  no clip: #{p.number} {p.title}")
    return 0


def cmd_record(args) -> int:
    import record

    repo = repo_dir(args.repo)
    dist = args.dist or os.path.join(repo, "bazel-bin", "web", "dist")
    if not os.path.isfile(os.path.join(dist, "index.html")):
        sys.exit(f"release_clips: no built app at {dist} (bazel build //web:dist)")
    plan_json: dict = {}
    if args.spec:
        specs = [
            clipspec.load_spec(repo, os.path.relpath(os.path.abspath(p), repo)) for p in args.spec
        ]
    else:
        plan = make_plan(args)
        plan_json = plan.to_json()
        specs = plan.clips
        if args.draft_uncovered and plan.uncovered:
            import draft

            ddir = os.path.join(args.out, "drafts")
            for pr in plan.uncovered:
                try:
                    spec = draft.draft_spec(repo, pr, ddir)
                except Exception as e:  # no credentials, API trouble: the PR stays uncovered
                    _log(f"release_clips: draft for #{pr.number} failed: {e}")
                    continue
                if spec:
                    _log(f"release_clips: drafted {spec.id} for #{pr.number}")
                    specs.append(spec)
    if args.only:
        specs = [s for s in specs if s.id in set(args.only)]
    os.makedirs(args.out, exist_ok=True)
    if not specs:
        _log("release_clips: nothing to record")
    else:
        record.ensure_browser()
        _log(f"release_clips: recording {len(specs)} clip(s) from {dist}")
    entries = record.record_all(specs, dist, repo, args.out, framings=args.framing) if specs else []
    release_prs = {c["id"]: c["release_prs"] for c in plan_json.get("clips", [])}
    for e in entries:
        e["release_prs"] = release_prs.get(e["id"], e.get("prs", []))
    with open(os.path.join(args.out, CLIPS_JSON), "w") as f:
        json.dump({"plan": plan_json, "clips": entries}, f, indent=1)
        f.write("\n")
    failed = [e["id"] for e in entries if e.get("error")]
    _log(
        f"release_clips: {len(entries) - len(failed)} recorded, {len(failed)} failed -> {args.out}"
    )
    return 1 if failed and args.strict else 0


def cmd_draft(args) -> int:
    import draft

    repo = repo_dir(args.repo)
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    meta = features.github_pr_fetcher(args.github_repo, token)(args.pr)
    sha = meta.get("merge_commit_sha")
    pr = features.PullRequest(
        number=args.pr,
        title=meta.get("title", ""),
        sha=sha,
        files=features.commit_files(repo, sha) if sha else [],
        body=meta.get("body") or "",
        labels=[x["name"] for x in meta.get("labels", [])],
    )
    spec = draft.draft_spec(repo, pr, args.out)
    if not spec:
        _log("release_clips: no draft")
        return 1
    print(os.path.join(args.out, f"{spec.id}.clip.json"))
    return 0


def load_clips(clips_dir: str) -> dict:
    with open(os.path.join(clips_dir, CLIPS_JSON)) as f:
        return json.load(f)


PAGE_CSS = """\
:root {
  --bg: #f6f6f8;
  --card: #fff;
  --text: #17171c;
  --dim: #5d5d6b;
  --border: #dedee6;
  --accent: #4b63d8;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111116;
    --card: #1b1b22;
    --text: #ececf1;
    --dim: #a0a0ae;
    --border: #2c2c36;
    --accent: #8ea2ff;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111116;
  --card: #1b1b22;
  --text: #ececf1;
  --dim: #a0a0ae;
  --border: #2c2c36;
  --accent: #8ea2ff;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
}
main {
  max-width: 1040px;
  margin: 0 auto;
  padding: 24px 16px 48px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
header h1 {
  margin: 0 0 4px;
  font-size: 1.5rem;
}
header p {
  margin: 0;
  color: var(--dim);
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
}
.card h2 {
  margin: 0 0 6px;
  font-size: 1.15rem;
}
.card p {
  margin: 0 0 8px;
}
.meta {
  color: var(--dim);
  font-size: .85rem;
}
.err {
  color: #c0392b;
}
.badge {
  font-size: .75rem;
  font-weight: 600;
  border: 1px solid var(--accent);
  color: var(--accent);
  border-radius: 999px;
  padding: 1px 8px;
  vertical-align: middle;
}
.vids {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
figure.phone {
  width: min(300px, 100%);
}
figure.desktop {
  width: min(620px, 100%);
}
video {
  width: 100%;
  height: auto;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #000;
}
figcaption {
  color: var(--dim);
  font-size: .8rem;
}
"""


def review_page(data: dict, title: str) -> str:
    """index.html showing every clip as the app plays it (muted, looping,
    inline, poster) with its title and summary. Light/dark aware, no scripts."""
    e = html.escape
    cards = []
    for c in data["clips"]:
        if c.get("error"):
            cards.append(
                f'<article class="card bad"><h2>{e(c["title"])}</h2><p class="err">Not recorded: '
                f'{e(c["error"])}</p><p class="meta">{e(c["path"])}</p></article>'
            )
            continue
        vids = []
        for v in c["variants"]:
            vids.append(
                f'<figure class="{e(v["framing"])}"><video src="{e(v["mp4"])}" poster="{e(v["poster"])}" '
                f'muted loop autoplay playsinline controls preload="metadata" width="{v["width"]}" '
                f'height="{v["height"]}"></video><figcaption>{e(v["framing"])} · {v["duration"]:.1f} s · '
                f'{v["bytes"]["mp4"] // 1024} KB</figcaption></figure>'
            )
        prs = " ".join(f"#{n}" for n in c.get("release_prs") or c.get("prs") or [])
        badge = '<span class="badge">drafted by agent</span>' if c.get("drafted") else ""
        cards.append(
            f'<article class="card"><h2>{e(c["title"])} {badge}</h2><p>{e(c["summary"])}</p>'
            f'<p class="meta">{e(prs)} · {e(c["path"])}</p><div class="vids">{"".join(vids)}</div></article>'
        )
    plan = data.get("plan") or {}
    unc = plan.get("uncovered") or []
    unc_html = ""
    if unc:
        items = "".join(f"<li>#{u['number']} {e(u['title'])}</li>" for u in unc)
        unc_html = f'<section class="card"><h2>User-visible changes without a preview</h2><ul>{items}</ul></section>'
    rng = f'{e(plan.get("since") or "")}..{e(plan.get("ref") or "")}' if plan else ""
    intro = (
        "Feature previews recorded from the release build"
        + (f" ({rng})" if rng else "")
        + ". These play in the app's What's new card and appear as GIFs on the GitHub release."
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<style>
{PAGE_CSS}</style></head>
<body><main>
<header><h1>{e(title)}</h1><p>{intro}</p></header>
{"".join(cards) or '<p class="card">No clips for this release.</p>'}
{unc_html}
</main></body></html>
"""


def cmd_page(args) -> int:
    data = load_clips(args.clips)
    os.makedirs(args.out, exist_ok=True)
    for c in data["clips"]:
        for v in c.get("variants", []):
            for k in ("mp4", "poster"):
                src = os.path.join(args.clips, v[k])
                if os.path.abspath(args.out) != os.path.abspath(args.clips):
                    shutil.copy2(src, os.path.join(args.out, v[k]))
    title = args.title or f"Feature previews: {(data.get('plan') or {}).get('tag') or 'release'}"
    with open(os.path.join(args.out, "index.html"), "w") as f:
        f.write(review_page(data, title))
    print(os.path.join(args.out, "index.html"))
    return 0


def cmd_publish(args) -> int:
    import github_release

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("release_clips: publish needs GH_TOKEN")
    data = load_clips(args.clips)
    gh = github_release.GitHub(args.github_repo, token)
    github_release.publish(gh, args.tag, args.clips, data["clips"], log=_log)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", help="checkout (default: $BUILD_WORKSPACE_DIRECTORY or cwd)")
    ap.add_argument("--github-repo", default=os.environ.get("GITHUB_REPOSITORY", "fughilli/splanc"))
    sub = ap.add_subparsers(dest="cmd", required=True)

    def range_args(p):
        p.add_argument("--tag", help="the app-v tag being released (default: plan up to HEAD)")
        p.add_argument(
            "--since", help="previous release tag (default: the newest app-v below --tag)"
        )
        p.add_argument(
            "--ref", help="commit to plan up to (default: --tag if it exists, else HEAD)"
        )
        p.add_argument("--offline", action="store_true", help="no GitHub PR metadata (git only)")

    p = sub.add_parser("plan", help="list the release's clips and uncovered PRs")
    range_args(p)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_plan)

    p = sub.add_parser("record", help="record clips into --out")
    range_args(p)
    p.add_argument("--out", required=True)
    p.add_argument("--dist", help="built app (default: bazel-bin/web/dist)")
    p.add_argument("--spec", action="append", help="record these clip scripts instead of the plan")
    p.add_argument("--only", action="append", help="only these clip ids")
    p.add_argument("--framing", action="append", choices=clipspec.FRAMINGS)
    p.add_argument(
        "--draft-uncovered", action="store_true", help="draft scripts for uncovered PRs (Claude)"
    )
    p.add_argument("--strict", action="store_true", help="exit 1 if any clip failed")
    p.set_defaults(fn=cmd_record)

    p = sub.add_parser("draft", help="draft a clip script for one PR (Claude)")
    p.add_argument("--pr", type=int, required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_draft)

    p = sub.add_parser("page", help="write a review page for recorded clips")
    p.add_argument("--clips", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--title")
    p.set_defaults(fn=cmd_page)

    p = sub.add_parser("publish", help="put recorded clips on the tag's GitHub release")
    p.add_argument("--tag", required=True)
    p.add_argument("--clips", required=True)
    p.set_defaults(fn=cmd_publish)

    args = ap.parse_args(argv)
    if getattr(args, "out", None):
        args.out = os.path.abspath(args.out)
    if getattr(args, "clips", None):
        args.clips = os.path.abspath(args.clips)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
