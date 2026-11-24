"""Agent fallback: draft a clip script for a user-visible PR that shipped
without one.

Claude reads the PR (title, description, the app-source diff), the clip format,
the app's routes and demo scenarios, and the checked-in clip scripts as
examples, and writes one ``<id>.clip.json``. The draft is validated here and
then recorded like any other clip; it is marked ``"drafted": true`` so the
review shows it was machine-written. A draft is never committed by this tool:
if the owner approves it, the agent that cut the release checks it in next to
the feature (``docs/release-clips.md``).

Needs ANTHROPIC_API_KEY (or another credential the SDK resolves). Without one
the release simply lists the PR as having no preview.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Optional

from clipspec import ClipSpec, SpecError, find_specs, parse_spec
from features import PullRequest

MODEL = "claude-opus-5-5"
MAX_DIFF_CHARS = 60_000

FORMAT_DOC = """\
A clip script is ONE JSON object:
{
  "schema": 1,
  "id": "kebab-case-id",              // 2-48 chars, [a-z0-9-]
  "title": "...",                     // <= 60 chars, what the user gets, sentence case
  "summary": "...",                   // <= 240 chars, one or two plain sentences for release notes
  "prs": [123],
  "route": "#/maps",                  // hash route the demo starts on
  "demo": "",                         // optional ?demo= scenarios, comma-joined
  "framing": ["phone"],               // always ["phone"] unless the feature is desktop-only
  "theme": "dark",                    // always "dark" unless the feature is about the light theme
                                      // (either exception needs "why_not_phone_dark": "<reason>")
  "storage": {},                      // optional localStorage seeds (string values)
  "setup": [],                        // optional steps run BEFORE recording starts
  "steps": [ ... ]                    // recorded steps, 5-15 s in total
}
Steps (each one object; selectors are Playwright selectors: CSS, :has-text('...'), >>):
  {"click": SEL, "wait": ms}          a finger moves to SEL and taps it
  {"type": SEL, "text": "...", "wait": ms}
  {"press": "Escape", "wait": ms}
  {"select": SEL, "label": "Option text", "wait": ms}
  {"scroll": SEL or "page", "by": px, "duration": ms, "wait": ms}
  {"wait_for": SEL, "timeout": ms}
  {"caption": "short text", "ms": 1600}   a caption pill over the top of the frame
  {"wait": ms}
Rules: demo data only (the built-in sample maps/effects, ?demo= scenarios); never
type real names, keys, emails or URLs. Prefer selectors that are visible text or
stable class names from the diff. Show the change itself, end on its result.
"""


def _routes(repo: str) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", repo, "grep", "-hoE", r"\.add\(\"/[^\"]*\"", "--", "web/src/ui/app/main.ts"],
            capture_output=True, text=True, check=False,
        ).stdout  # fmt: skip
    except OSError:
        return []
    return sorted({"#" + m[len('.add("') : -1] for m in out.splitlines()})


def _demo_doc(repo: str) -> str:
    p = os.path.join(repo, "web/src/demo/init.ts")
    try:
        src = open(p).read()
    except OSError:
        return ""
    m = re.search(r"/\*\*(.*?)\*/", src, re.S)
    return m.group(1) if m else ""


def _diff(repo: str, pr: PullRequest) -> str:
    files = pr.visible_files
    if not files:
        return ""
    out = subprocess.run(
        ["git", "-C", repo, "diff", f"{pr.sha}^1", pr.sha, "--", *files],
        capture_output=True, text=True, check=False,
    ).stdout  # fmt: skip
    if len(out) > MAX_DIFF_CHARS:
        out = out[:MAX_DIFF_CHARS] + "\n[diff truncated]\n"
    return out


def build_prompt(repo: str, pr: PullRequest) -> str:
    examples = []
    for rel in find_specs(repo)[:3]:
        with open(os.path.join(repo, rel)) as f:
            examples.append(f"// {rel}\n{f.read()}")
    return "\n\n".join(
        [
            "Write a feature-preview clip script for this Splanc app change. A headless "
            "browser runs it against the built app and records a 5-15 second looping "
            "video for the release notes.",
            FORMAT_DOC,
            "App routes: " + ", ".join(_routes(repo)),
            "Demo scenarios (?demo=):\n" + _demo_doc(repo),
            "Existing clip scripts (examples):\n" + "\n\n".join(examples),
            f"PR #{pr.number}: {pr.title}\n\n{pr.body[:6000]}",
            "App-source diff:\n" + _diff(repo, pr),
            "Answer with the JSON object only, in one ```json fenced block.",
        ]
    )


def _extract_json(text: str) -> object:
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{") : text.rfind("}") + 1]
    return json.loads(raw)


def draft_spec(repo: str, pr: PullRequest, out_dir: str, client=None) -> Optional[ClipSpec]:
    """Ask Claude for a clip script; validate; on a validation error ask once
    more with the error. Writes <out_dir>/<id>.clip.json and returns the spec."""
    import anthropic

    client = client or anthropic.Anthropic()
    messages = [{"role": "user", "content": build_prompt(repo, pr)}]
    for _attempt in range(2):
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium"},
            messages=messages,
        )
        if resp.stop_reason == "refusal":
            return None
        text = "".join(b.text for b in resp.content if b.type == "text")
        try:
            obj = _extract_json(text)
            if not isinstance(obj, dict):
                raise SpecError("not a JSON object")
            obj["drafted"] = True
            obj.setdefault("prs", [pr.number])
            rel = os.path.join(out_dir, f"{obj.get('id', 'draft')}.clip.json")
            spec = parse_spec(obj, rel)
        except (ValueError, SpecError) as e:
            messages += [
                {"role": "assistant", "content": resp.content},
                {
                    "role": "user",
                    "content": f"That script is invalid: {e}. Send the corrected JSON object.",
                },
            ]
            continue
        os.makedirs(out_dir, exist_ok=True)
        with open(rel, "w") as f:
            json.dump(obj, f, indent=2)
            f.write("\n")
        return spec
    return None
