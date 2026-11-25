"""Offline tests for the feature-preview clip tooling: the clip format (and every
checked-in clip script), release planning on a scratch git repo, the release
body section, the manifest and the review page. No browser, ffmpeg or network."""

import json
import os
import subprocess
import tempfile
import unittest

import clipspec
import features
import github_release
import release_clips

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))  # runfiles root (_main) or the checkout


def spec(**over):
    base = {
        "schema": 1,
        "id": "demo-clip",
        "title": "A demo",
        "summary": "Shows the demo.",
        "steps": [{"click": ".tab[data-tab='maps']", "wait": 500}],
    }
    base.update(over)
    return base


class ClipSpecTest(unittest.TestCase):
    def test_checked_in_clip_scripts_are_valid(self):
        specs = clipspec.load_all(REPO)
        self.assertGreaterEqual(len(specs), 1, "no clip scripts found under web/src")
        for s in specs:
            for src in s.fixtures.values():
                self.assertTrue(
                    os.path.isfile(os.path.join(REPO, src)), f"{s.id}: missing fixture {src}"
                )
            self.assertLessEqual(
                clipspec.estimate_seconds(s.steps, s.tail_ms), clipspec.MAX_SECONDS + 3
            )

    def test_defaults(self):
        s = clipspec.parse_spec(spec(), "web/src/x/demo-clip.clip.json")
        self.assertEqual((s.route, s.framing, s.theme, s.demo), ("#/maps", ["phone"], "dark", ""))

    def test_rejects(self):
        cases = [
            (spec(id="Bad Id"), "id must match"),
            (spec(), "file name must be"),  # checked against the path below
            (spec(steps=[{"jump": "x"}]), "unknown step"),
            (spec(steps=[{"click": ".a", "colour": 1}]), "unknown keys"),
            (spec(steps=[{"wait": 99999}]), "0..6000"),
            (spec(steps=[{"type": ".a"}]), "needs 'text'"),
            (spec(framing=["watch"]), "framing"),
            (spec(route="/maps"), "hash route"),
            (spec(fixtures={"/x.json": "../secret"}), "repo-relative"),
            (spec(steps=[{"wait": 6000}] * 4), "at most 15s"),
            (spec(title="x" * 61), "60 characters"),
            (spec(extra=1), "unknown keys"),
            (spec(framing=["phone", "desktop"]), "why_not_phone_dark"),
            (spec(theme="light"), "why_not_phone_dark"),
        ]
        for obj, msg in cases:
            path = (
                "web/src/other-name.clip.json"
                if msg == "file name must be"
                else f"web/{obj['id']}.json"
            )
            with self.subTest(msg=msg), self.assertRaises(clipspec.SpecError) as cm:
                clipspec.parse_spec(obj, path)
            self.assertIn(msg, str(cm.exception))

    def test_desktop_or_light_with_a_reason(self):
        s = clipspec.parse_spec(
            spec(framing=["desktop"], theme="light", why_not_phone_dark="desktop-only shortcut"),
            "web/src/x/demo-clip.clip.json",
        )
        self.assertEqual((s.framing, s.theme), (["desktop"], "light"))

    def test_a_scroll_step_with_a_wait_is_a_scroll(self):
        s = clipspec.parse_spec(
            spec(steps=[{"scroll": ".k-sheet", "by": 300, "wait": 200}]), "x.json"
        )
        self.assertEqual(clipspec._step_kind(s.steps[0]), "scroll")

    def test_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as d:
            for sub in ("a", "b"):
                os.makedirs(os.path.join(d, "web", "src", sub))
                with open(os.path.join(d, "web", "src", sub, "demo-clip.clip.json"), "w") as f:
                    json.dump(spec(), f)
            with self.assertRaises(clipspec.SpecError):
                clipspec.load_all(d)


class PlanTest(unittest.TestCase):
    """A scratch repo: app-v1.0.0, then a UI PR with a clip script, a UI PR
    without one, a docs PR, and a PR named by an older clip's `prs`."""

    def git(self, *args):
        subprocess.run(["git", "-C", self.d, *args], check=True, capture_output=True)

    def commit(self, files: dict, subject: str):
        for path, text in files.items():
            full = os.path.join(self.d, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(text)
            self.git("add", path)
        self.git("commit", "-q", "-m", subject)

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        old = spec(id="old-clip", prs=[14])
        self.commit(
            {"web/src/a.ts": "1", "web/src/old/old-clip.clip.json": json.dumps(old)}, "base (#9)"
        )
        self.git("tag", "app-v1.0.0")
        new = spec(id="new-clip")
        self.commit(
            {"web/src/ui/new.ts": "x", "web/src/ui/new-clip.clip.json": json.dumps(new)},
            "UI: a new screen (#11)",
        )
        self.commit({"web/src/ui/fix.ts": "y", "web/tests/fix.test.ts": "t"}, "UI: a fix (#12)")
        self.commit({"docs/x.md": "d"}, "docs: words (#13)")
        self.commit({"web/src/old/thing.ts": "z"}, "Old feature, round two (#14)")
        self.commit({"web/src/demo/init.ts": "z", "web/README.md": "r"}, "demo seam only (#15)")
        self.commit({"pi/data.json": "1"}, "data refresh [skip ci]")

    def test_plan(self):
        tags = ["app-v1.0.0", "firmware-v1.0.0"]
        self.assertEqual(
            features.previous_app_tag(tags + ["app-v1.1.0"], "app-v1.1.0"), "app-v1.0.0"
        )
        self.assertIsNone(features.previous_app_tag(tags, "app-v1.0.0"))
        prs = features.collect_prs(self.d, "app-v1.0.0", "HEAD")
        self.assertEqual([p.number for p in prs], [15, 14, 13, 12, 11])
        visible = {p.number: p.user_visible for p in prs}
        self.assertEqual(visible, {15: False, 14: True, 13: False, 12: True, 11: True})
        plan = features.make_plan(
            clipspec.load_all(self.d), prs, "app-v1.1.0", "app-v1.0.0", "HEAD"
        )
        self.assertEqual(sorted(c.id for c in plan.clips), ["new-clip", "old-clip"])
        self.assertEqual(plan.clip_prs, {"new-clip": [11], "old-clip": [14]})
        self.assertEqual([p.number for p in plan.uncovered], [12])
        j = plan.to_json()
        self.assertEqual(j["uncovered"], [{"number": 12, "title": "UI: a fix"}])

    def test_labels(self):
        pr = features.PullRequest(13, "docs", "x", ["docs/x.md"], labels=["ui"])
        self.assertTrue(pr.user_visible)
        pr = features.PullRequest(12, "fix", "x", ["web/src/a.ts"], labels=["no-clip"])
        self.assertFalse(pr.user_visible)

    def test_metadata_failure_is_not_fatal(self):
        def boom(n):
            raise OSError("offline")

        logs = []
        prs = features.collect_prs(self.d, "app-v1.0.0", "HEAD", boom, logs.append)
        self.assertEqual(len(prs), 5)
        self.assertTrue(logs)


ENTRIES = [
    {
        "id": "ai-tab", "title": 'AI "tab"', "summary": "Pick <where> AI runs.", "path": "web/src/x/ai-tab.clip.json",
        "prs": [558], "release_prs": [558], "drafted": False, "error": None,
        "variants": [
            {"framing": "desktop", "mp4": "ai-tab-desktop.mp4", "webm": "ai-tab-desktop.webm",
             "gif": "ai-tab-desktop.gif",
             "poster": "ai-tab-desktop.jpg", "width": 1120, "height": 700, "duration": 9.0,
             "bytes": {"mp4": 1, "webm": 1, "gif": 1, "poster": 1}},
            {"framing": "phone", "mp4": "ai-tab-phone.mp4", "webm": "ai-tab-phone.webm", "gif": "ai-tab-phone.gif",
             "poster": "ai-tab-phone.jpg", "width": 600, "height": 1298, "duration": 9.0,
             "bytes": {"mp4": 1, "webm": 1, "gif": 1, "poster": 1}},
        ],
    },
    {"id": "broken", "title": "Broken", "summary": "x", "path": "p", "prs": [], "drafted": True,
     "error": "TimeoutError: .missing", "variants": []},
]  # fmt: skip


class ReleaseBodyTest(unittest.TestCase):
    def test_manifest_skips_failed_clips(self):
        m = github_release.build_manifest(ENTRIES, "app-v1.16.0")
        self.assertEqual([c["id"] for c in m["clips"]], ["ai-tab"])
        self.assertNotIn("bytes", m["clips"][0]["variants"][0])
        self.assertEqual(github_release.clip_assets(ENTRIES[:1])[:4], [
            "ai-tab-desktop.mp4", "ai-tab-desktop.webm", "ai-tab-desktop.gif", "ai-tab-desktop.jpg"])  # fmt: skip

    def test_section(self):
        m = github_release.build_manifest(ENTRIES, "app-v1.16.0")
        sec = github_release.section_markdown(m, "fughilli/splanc")
        dl = "https://github.com/fughilli/splanc/releases/download/app-v1.16.0/"
        self.assertIn("## Feature previews", sec)
        # Phone GIF first (narrow), linking its MP4; both MP4s linked.
        self.assertIn(
            f'<a href="{dl}ai-tab-phone.mp4"><img src="{dl}ai-tab-phone.gif" alt="AI &quot;tab&quot;" width="280">',
            sec,
        )
        self.assertIn(f"[desktop video (MP4)]({dl}ai-tab-desktop.mp4)", sec)
        self.assertIn("(#558)", sec)
        self.assertEqual(github_release.section_markdown({"tag": "x", "clips": []}, "r"), "")

    def test_a_draft_links_its_own_urls_and_relink_moves_them_to_the_tag(self):
        m = github_release.build_manifest(ENTRIES, "app-v1.16.0")
        draft = {
            "draft": True,
            "html_url": "https://github.com/fughilli/splanc/releases/tag/untagged-de0f20b6e5",
        }
        base = github_release.release_download_base(draft, "fughilli/splanc", "app-v1.16.0")
        self.assertEqual(
            base, "https://github.com/fughilli/splanc/releases/download/untagged-de0f20b6e5/"
        )
        sec = github_release.section_markdown(m, "fughilli/splanc", base)
        self.assertIn(f'<img src="{base}ai-tab-phone.gif"', sec)
        self.assertNotIn("/download/app-v1.16.0/", sec)
        body = github_release.splice_body("## What's Changed\n", sec)
        final = github_release.relink_body(body, "fughilli/splanc", "app-v1.16.0")
        self.assertNotIn("untagged-", final)
        self.assertEqual(
            final,
            github_release.splice_body(
                "## What's Changed\n", github_release.section_markdown(m, "fughilli/splanc")
            ),
        )
        # Published (or a draft without a placeholder): the tag's URLs.
        self.assertEqual(
            github_release.release_download_base(
                {"draft": False}, "fughilli/splanc", "app-v1.16.0"
            ),
            "https://github.com/fughilli/splanc/releases/download/app-v1.16.0/",
        )

    def test_splice_is_idempotent_and_keeps_notes(self):
        m = github_release.build_manifest(ENTRIES, "app-v1.16.0")
        sec = github_release.section_markdown(m, "fughilli/splanc")
        notes = "## What's Changed\n* a thing\n"
        once = github_release.splice_body(notes, sec)
        self.assertTrue(once.startswith(github_release.START))
        self.assertTrue(once.endswith(notes))
        self.assertEqual(github_release.splice_body(once, sec), once)
        self.assertEqual(github_release.splice_body(once, ""), notes)
        self.assertEqual(github_release.splice_body(notes, ""), notes)


class FakeGitHub(github_release.GitHub):
    def __init__(self, release):
        super().__init__("fughilli/splanc", "t")
        self.release, self.calls = release, []

    def release_for_tag(self, tag):
        return self.release if self.release["tag_name"] == tag else None

    def update_body(self, release, body):
        self.calls.append(("body", body))

    def delete_asset(self, asset_id):
        self.calls.append(("delete", asset_id))

    def upload_asset(self, release, path, name=None):
        assert os.path.isfile(path), path
        self.calls.append(("upload", name))


class ApiGitHub(github_release.GitHub):
    """A GitHub whose API is a list of releases in memory."""

    def __init__(self, rows):
        super().__init__("fughilli/splanc", "t")
        self.rows, self.calls, self.next_id = rows, [], 100

    def releases(self):
        return self.rows

    def create_release(self, fields):
        self.next_id += 1
        r = {**fields, "id": self.next_id, "assets": [], "upload_url": "https://u{?name}",
             "html_url": f"https://github.com/fughilli/splanc/releases/tag/untagged-{self.next_id:x}"}  # fmt: skip
        self.rows.append(r)
        self.calls.append(("create", fields["tag_name"]))
        return r

    def update_release(self, release, fields):
        release.update(fields)
        self.calls.append(("update", fields))
        return release

    def update_body(self, release, body):
        release["body"] = body
        self.calls.append(("body", body))

    def delete_asset(self, asset_id):
        self.calls.append(("delete", asset_id))

    def upload_asset(self, release, path, name=None):
        self.calls.append(("upload", name))


class DraftLifecycleTest(unittest.TestCase):
    def test_the_draft_is_found_by_name_reused_and_published_under_the_tag(self):
        # The app-v1.17.0 failure: the draft's tag read untagged-<id>, the re-run
        # made a second draft, and publishing made a third, empty release.
        old = {"id": 1, "draft": True, "tag_name": "untagged-aa", "name": "app-v1.17.0",
               "created_at": "2026-11-23", "assets": []}  # fmt: skip
        new = {"id": 2, "draft": True, "tag_name": "untagged-bb", "name": "app-v1.17.0", "created_at": "2026-11-25",
               "upload_url": "https://u{?name}", "assets": [{"name": "splanc-webapp-1.17.0.tar.gz", "id": 9}],
               "body": "[v](https://github.com/fughilli/splanc/releases/download/untagged-bb/a.mp4)"}  # fmt: skip
        other = {"id": 3, "draft": False, "tag_name": "app-v1.16.0", "name": "app-v1.16.0"}
        gh = ApiGitHub([old, other, new])
        log = lambda m: None  # noqa: E731
        self.assertIs(github_release.ensure_draft(gh, "app-v1.17.0", "abc", log=log), new)
        self.assertEqual(gh.calls, [])
        d = tempfile.mkdtemp()
        tar = os.path.join(d, "splanc-webapp-1.17.0.tar.gz")
        open(tar, "wb").close()
        github_release.finalize(gh, "app-v1.17.0", [tar], log=log)
        self.assertIn(("delete", 9), gh.calls)
        self.assertIn(("upload", "splanc-webapp-1.17.0.tar.gz"), gh.calls)
        self.assertIn(
            ("update", {"draft": False, "tag_name": "app-v1.17.0", "make_latest": "false"}),
            gh.calls,
        )
        self.assertEqual(
            new["body"],
            "[v](https://github.com/fughilli/splanc/releases/download/app-v1.17.0/a.mp4)",
        )
        self.assertFalse(any(k == "create" for k, _ in gh.calls))
        # Published now: it wins over the leftover draft.
        self.assertIs(gh.release_for_tag("app-v1.17.0"), new)

    def test_a_missing_draft_is_created_and_finalize_never_makes_a_release(self):
        gh = ApiGitHub([])
        r = github_release.ensure_draft(gh, "app-v1.18.0", "abc", log=lambda m: None)
        self.assertEqual(
            (r["draft"], r["name"], r["target_commitish"], r["generate_release_notes"]),
            (True, "app-v1.18.0", "abc", True),
        )
        with self.assertRaises(SystemExit):
            github_release.finalize(ApiGitHub([]), "app-v1.18.0", [], log=lambda m: None)


class PublishTest(unittest.TestCase):
    def test_publish_replaces_assets_and_writes_the_section(self):
        d = tempfile.mkdtemp()
        for v in ENTRIES[0]["variants"]:
            for k in ("mp4", "webm", "gif", "poster"):
                open(os.path.join(d, v[k]), "wb").close()
        rel = {"tag_name": "app-v1.16.0", "draft": True, "body": "## What's Changed\n",
               "html_url": "https://github.com/fughilli/splanc/releases/tag/untagged-abc123",
               "assets": [{"name": "ai-tab-phone.mp4", "id": 7}], "upload_url": "https://u{?name}"}  # fmt: skip
        gh = FakeGitHub(rel)
        man = github_release.publish(gh, "app-v1.16.0", d, ENTRIES, log=lambda m: None)
        self.assertEqual(len(man["clips"]), 1)
        self.assertIn(("delete", 7), gh.calls)
        uploads = [n for k, n in gh.calls if k == "upload"]
        self.assertEqual(len(uploads), 9)
        self.assertEqual(uploads[-1], "preview-clips.json")
        body = [b for k, b in gh.calls if k == "body"][0]
        self.assertIn("## Feature previews", body)
        self.assertTrue(body.endswith("## What's Changed\n"))
        self.assertIn("/releases/download/untagged-abc123/ai-tab-phone.gif", body)

        # Published: relink rewrites the notes to the tag's URLs, once.
        rel.update(draft=False, body=body)
        self.assertTrue(github_release.relink(gh, "app-v1.16.0", log=lambda m: None))
        final = [b for k, b in gh.calls if k == "body"][-1]
        self.assertIn("/releases/download/app-v1.16.0/ai-tab-phone.gif", final)
        self.assertNotIn("untagged-", final)
        rel["body"] = final
        self.assertFalse(github_release.relink(gh, "app-v1.16.0", log=lambda m: None))
        with open(os.path.join(d, "preview-clips.json")) as f:
            self.assertEqual(json.load(f)["tag"], "app-v1.16.0")


class ReviewPageTest(unittest.TestCase):
    def test_page(self):
        data = {"plan": {"tag": "app-v1.16.0", "since": "app-v1.15.7", "ref": "app-v1.16.0",
                         "uncovered": [{"number": 12, "title": "A <fix>"}]}, "clips": ENTRIES}  # fmt: skip
        page = release_clips.review_page(data, "Feature previews: app-v1.16.0")
        self.assertIn(
            '<video src="ai-tab-phone.mp4" poster="ai-tab-phone.jpg" muted loop autoplay playsinline',
            page,
        )
        self.assertIn("Pick &lt;where&gt; AI runs.", page)
        self.assertIn("Not recorded: TimeoutError", page)
        self.assertIn("#12 A &lt;fix&gt;", page)
        self.assertIn("prefers-color-scheme: dark", page)
        self.assertNotIn("<script", page)


class RecordHelpersTest(unittest.TestCase):
    def test_version_patch(self):
        import record

        js = b"a={gitCommitShort:`eefc105d`,gitDirty:!1,version:`1.15.7-17-geefc105d3`};"
        out = record.VERSION_RE.sub(lambda m: m[1] + b"1.16.0" + m[3], js)
        self.assertIn(b"version:`1.16.0`", out)

    def test_concat_list_holds_each_frame_until_the_next(self):
        import record

        d = tempfile.mkdtemp()
        frames = [
            record.Frame(100.0 + t, os.path.join(d, f"{i:05d}.jpg"))
            for i, t in enumerate((0, 0.5, 2.0))
        ]
        take = record.Take(None, "phone", frames, 100.0, 103.0, 102.0, d)
        with open(record._concat_list(take)) as f:
            text = f.read()
        self.assertIn("duration 0.5000", text)
        self.assertIn("duration 1.5000", text)
        self.assertIn("duration 1.0000", text)


if __name__ == "__main__":
    unittest.main()
