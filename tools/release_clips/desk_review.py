#!/usr/bin/env python3
"""Relay an app release's review between GitHub and the owner's Review Desk.

The Release workflow holds every app-v* release at the `release-review`
environment (job app_review) after recording its feature previews. This tool,
run by the agent that cut the release (in the container, where the desk lives):

  1. finds the tag's Release run waiting on `release-review`;
  2. downloads its `preview-clips` artifact and posts ONE desk item with the
     clips attached (GIFs play inline on the desk, plus the MP4s and the review
     page) and two options: "Approve release notes + clips" / "Changes needed";
  3. polls the item, and relays the answer to GitHub as the environment's
     approval (the release continues: deploy + publish) or rejection (the run
     fails; fix, then re-run the failed jobs and run this again).

The owner can also approve or reject in GitHub's "Review deployments" dialog;
the tool then notes that on the desk item and closes it. Approving needs a
token of a required reviewer of the environment (GH_TOKEN).

    bazel run //tools/release_clips:desk_review -- --tag app-v1.16.0 [--wait]

State (the desk item per run) is kept in --state-dir, so re-runs are idempotent.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ENV_NAME = "release-review"
ARTIFACT = "preview-clips"
APPROVE = "Approve release notes + clips"
CHANGES = "Changes needed"
DEFAULT_RD = "/workspace/.claude/reviewdesk/rd"
DEFAULT_STATE = "/workspace/.claude/clips/review-state"


def _log(m: str) -> None:
    print(m, file=sys.stderr, flush=True)


class Api:
    def __init__(self, repo: str, token: str) -> None:
        self.repo, self.token = repo, token

    def req(self, method: str, path: str, body: dict | None = None, raw: bool = False):
        url = (
            path
            if path.startswith("https://")
            else f"https://api.github.com/repos/{self.repo}{path}"
        )
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("Authorization", f"Bearer {self.token}")
        r.add_header("Accept", "application/vnd.github+json")
        r.add_header("User-Agent", "splanc-release-review")
        if data is not None:
            r.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(r, timeout=120) as resp:
            out = resp.read()
        return out if raw else (json.loads(out) if out else None)


def find_run(api: Api, tag: str) -> dict | None:
    runs = api.req("GET", f"/actions/runs?event=push&branch={tag}&per_page=20")["workflow_runs"]
    runs = [r for r in runs if r.get("name") == "Release"]
    return runs[0] if runs else None


def pending_env(api: Api, run_id: int) -> dict | None:
    for p in api.req("GET", f"/actions/runs/{run_id}/pending_deployments") or []:
        if p.get("environment", {}).get("name") == ENV_NAME:
            return p
    return None


def fetch_clips(api: Api, run_id: int, dest: str) -> str:
    arts = api.req("GET", f"/actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
    art = next((a for a in arts if a["name"] == ARTIFACT and not a.get("expired")), None)
    if art is None:
        raise SystemExit(f"desk_review: run {run_id} has no {ARTIFACT} artifact (yet)")
    blob = api.req("GET", art["archive_download_url"], raw=True)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for n in z.namelist():  # flat artifact; refuse anything that climbs out
            if os.path.isabs(n) or ".." in n.split("/"):
                raise SystemExit(f"desk_review: unsafe path in artifact: {n}")
        z.extractall(dest)
    return dest


def item_body(tag: str, run: dict, release_url: str, data: dict) -> str:
    plan = data.get("plan") or {}
    lines = [
        f"**{tag}** is built and waiting for your approval before it ships "
        f"(web app deploy + the GitHub release). [Release run]({run['html_url']}) · "
        f"[draft release]({release_url})",
        "",
        "Feature previews recorded from this build (they play in the app's What's new "
        "card; GitHub shows the GIFs). The attached GIFs play here; the MP4s are what "
        "the app plays.",
        "",
    ]
    for c in data["clips"]:
        prs = " ".join(f"#{n}" for n in c.get("release_prs") or c.get("prs") or [])
        if c.get("error"):
            lines.append(f"- **{c['title']}** ({prs}): not recorded, `{c['error'][:160]}`")
        else:
            tag_d = " *(script drafted by the agent)*" if c.get("drafted") else ""
            lines.append(f"- **{c['title']}** ({prs}){tag_d}: {c['summary']}")
    if not data["clips"]:
        lines.append("- No clip scripts in this release.")
    unc = plan.get("uncovered") or []
    if unc:
        lines += ["", "User-visible PRs without a preview:"]
        lines += [f"- #{u['number']} {u['title']}" for u in unc]
    lines += [
        "",
        f"**{APPROVE}** publishes the release. **{CHANGES}**: say what to change in a "
        "comment; the run is stopped, the agent fixes the clips or notes and asks again.",
    ]
    return "\n".join(lines)


def rd(rd_path: str, *args: str) -> str:
    return subprocess.run([rd_path, *args], check=True, capture_output=True, text=True).stdout


def post_item(
    rd_path: str, tag: str, body: str, clips_dir: str, data: dict, links: list[str]
) -> int:
    body_file = os.path.join(clips_dir, "desk-body.md")
    with open(body_file, "w") as f:
        f.write(body)
    out = rd(
        rd_path, "new",
        "--title", f"Release {tag}: approve the release notes and feature previews",
        "--body-file", body_file, "--project", "release", "--priority", "blocking",
        "--option", f"{APPROVE}|deploy the app and publish the release with these notes and clips|recommended",
        "--option", f"{CHANGES}|stop this release run; say what to change in a comment",
        "--json",
    )  # fmt: skip
    item = json.loads(out[out.index("{") :])  # after the "created #N" line
    iid = int(item["id"])
    for c in data["clips"]:
        for v in c.get("variants", []):
            label = f"{c['title']} ({v['framing']})"
            rd(rd_path, "attach", str(iid), os.path.join(clips_dir, v["gif"]), "--label", label)
            rd(
                rd_path,
                "attach",
                str(iid),
                os.path.join(clips_dir, v["mp4"]),
                "--label",
                label + " MP4",
            )
    page = os.path.join(clips_dir, "index.html")
    if os.path.isfile(page):
        rd(
            rd_path,
            "attach",
            str(iid),
            page,
            "--label",
            "Review page (open with the MP4s next to it)",
        )
    for url in links:
        rd(rd_path, "attach", str(iid), url)
    return iid


def answer(rd_path: str, iid: int) -> tuple[str | None, str]:
    """(APPROVE | CHANGES | None, the owner's text + latest comment)."""
    item = json.loads(rd(rd_path, "show", str(iid), "--json"))
    answers = item.get("answers") or []
    if not answers:
        return None, ""
    last = answers[-1]
    opts = {o["key"]: o["label"] for o in item.get("options") or []}
    labels = [opts.get(k, k) for k in last.get("choices") or []]
    comments = [c.get("body", "") for c in item.get("comments") or [] if c.get("author") == "owner"]
    note = "\n".join(x for x in [last.get("text") or "", comments[-1] if comments else ""] if x)
    if APPROVE in labels:
        return APPROVE, note
    if CHANGES in labels:
        return CHANGES, note
    return None, note


def decide(api: Api, run_id: int, env_id: int, approve: bool, comment: str) -> None:
    api.req(
        "POST",
        f"/actions/runs/{run_id}/pending_deployments",
        {
            "environment_ids": [env_id],
            "state": "approved" if approve else "rejected",
            "comment": comment[:1000],
        },
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tag", required=True)
    ap.add_argument("--github-repo", default=os.environ.get("GITHUB_REPOSITORY", "fughilli/splanc"))
    ap.add_argument("--rd", default=os.environ.get("RD", DEFAULT_RD))
    ap.add_argument("--state-dir", default=DEFAULT_STATE)
    ap.add_argument("--wait", action="store_true", help="poll until answered (default: one pass)")
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args(argv)
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("desk_review: needs GH_TOKEN (a required reviewer's token to approve)")
    api = Api(args.github_repo, token)
    os.makedirs(args.state_dir, exist_ok=True)

    while True:
        run = find_run(api, args.tag)
        if run is None:
            _log(f"desk_review: no Release run for {args.tag} yet")
        else:
            state_path = os.path.join(
                args.state_dir, f"{args.tag}-{run['id']}-{run['run_attempt']}.json"
            )
            state = json.load(open(state_path)) if os.path.exists(state_path) else {}
            pend = pending_env(api, run["id"])
            iid = state.get("item")
            if pend is None:
                if iid and not state.get("closed"):
                    rd(args.rd, "close", str(iid), "--comment",
                       f"The run is no longer waiting for review ({run['status']}/{run.get('conclusion')}); "
                       "it was decided on GitHub or cancelled.")  # fmt: skip
                    state["closed"] = True
                    json.dump(state, open(state_path, "w"))
                _log(f"desk_review: run {run['id']} is not waiting on {ENV_NAME} ({run['status']})")
                if run["status"] == "completed" or state.get("closed"):
                    return 0
            elif iid is None:
                clips_dir = fetch_clips(
                    api, run["id"], os.path.join(args.state_dir, f"{args.tag}-{run['id']}")
                )
                with open(os.path.join(clips_dir, "clips.json")) as f:
                    data = json.load(f)
                rel = api.req("GET", "/releases?per_page=30")
                rel = next((r for r in rel if r.get("tag_name") == args.tag), {})
                release_url = (
                    rel.get("html_url") or f"https://github.com/{args.github_repo}/releases"
                )
                body = item_body(args.tag, run, release_url, data)
                iid = post_item(
                    args.rd, args.tag, body, clips_dir, data, [run["html_url"], release_url]
                )
                state.update(item=iid, run=run["id"], env=pend["environment"]["id"])
                json.dump(state, open(state_path, "w"))
                _log(f"desk_review: posted D-{iid} for {args.tag} (run {run['id']})")
            else:
                verdict, note = answer(args.rd, iid)
                if verdict is not None:
                    approve = verdict == APPROVE
                    decide(api, run["id"], pend["environment"]["id"], approve,
                           f"{verdict} on the Review Desk (D-{iid}). {note}".strip())  # fmt: skip
                    msg = ("Approved: the release run continues (deploy + publish)." if approve else
                           "Rejected: the release run is stopped. Fix, re-run the failed jobs, "
                           "and a new review item follows.")  # fmt: skip
                    rd(args.rd, "comment", str(iid), "--body", msg)
                    if approve:
                        rd(args.rd, "close", str(iid))
                    state.update(decided=verdict)
                    json.dump(state, open(state_path, "w"))
                    _log(f"desk_review: {verdict} relayed for run {run['id']}")
                    return 0
                _log(f"desk_review: D-{iid} not answered yet")
        if not args.wait:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
