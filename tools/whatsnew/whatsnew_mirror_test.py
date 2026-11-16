"""Tests for the release-notes mirror: the HTML allowlist, media URL rewriting
and release selection, against a fixture releases list and a fake network."""

import json
import os
import tempfile
import unittest
import urllib.error

import whatsnew_mirror as wm

HERE = os.path.dirname(os.path.abspath(__file__))
PNG = b"\x89PNG\r\n\x1a\n" + b"fake-png"
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"fake-mp4"


def load_fixture():
    with open(os.path.join(HERE, "testdata", "releases.json")) as f:
        return json.load(f)


class FakeNet:
    """Serves the fixture's media; anything else 404s. Records every fetch."""

    def __init__(self):
        self.calls = []
        self.files = {
            "https://github.com/user-attachments/assets/aaaa-1111": (PNG, "image/png"),
            "https://github.com/user-attachments/assets/bbbb-2222": (MP4, "video/mp4"),
            "https://github.com/fughilli/splanc/releases/download/app-v1.10.0/light-show.png": (
                PNG + b"2",
                "application/octet-stream",
            ),
        }

    def __call__(self, url):
        self.calls.append(url)
        if url in self.files:
            return self.files[url]
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)


def walk(nodes):
    for n in nodes:
        yield n
        if isinstance(n, dict):
            yield from walk(n.get("c", []))


def text_of(nodes):
    return "".join(n for n in walk(nodes) if isinstance(n, str))


class SanitizerTest(unittest.TestCase):
    def test_drops_scripts_styles_iframes_and_handlers(self):
        nodes, _ = wm.html_to_nodes(
            '<p onclick="x()">hi<script>alert(1)</script></p><style>p{}</style>'
            '<iframe src="https://evil"><p>in</p></iframe><svg><a href="x">s</a></svg>'
        )
        self.assertEqual(nodes, [{"t": "p", "c": ["hi"]}])

    def test_link_schemes(self):
        nodes, _ = wm.html_to_nodes(
            '<p><a href="javascript:alert(1)">a</a> <a href="https://ok.example/">b</a>'
            ' <a href=" JAVASCRIPT:x">c</a> <a href="mailto:x@y.z">d</a></p>'
        )
        links = [n for n in walk(nodes) if isinstance(n, dict) and n["t"] == "a"]
        self.assertEqual(
            [n["a"] for n in links], [{"href": "https://ok.example/"}, {"href": "mailto:x@y.z"}]
        )
        self.assertEqual(text_of(nodes), "a b c d")

    def test_unwraps_unknown_tags_and_aliases(self):
        nodes, _ = wm.html_to_nodes('<div class="x"><span>a <b>b</b> <i>c</i></span></div>')
        self.assertEqual(nodes, ["a ", {"t": "strong", "c": ["b"]}, " ", {"t": "em", "c": ["c"]}])
        self.assertEqual(text_of(nodes), "a b c")
        tags = [n["t"] for n in walk(nodes) if isinstance(n, dict)]
        self.assertEqual(tags, ["strong", "em"])

    def test_media_needs_http_source(self):
        nodes, media = wm.html_to_nodes(
            '<p><img src="data:image/png;base64,AA" alt="x"><img src="/rel.png"></p>'
        )
        self.assertEqual(nodes, [])
        self.assertEqual(media, [])

    def test_attribute_allowlist(self):
        nodes, media = wm.html_to_nodes(
            '<img src="https://h/a.png" alt="A" width="640px" height="big" style="x" class="y">'
            '<video src="https://h/v.mp4" controls="controls" muted autoplay onplay="x"></video>'
        )
        self.assertEqual(
            nodes[0], {"t": "img", "a": {"src": "https://h/a.png", "alt": "A", "width": 640}}
        )
        self.assertEqual(
            nodes[1],
            {"t": "video", "a": {"src": "https://h/v.mp4", "controls": True, "muted": True}},
        )
        self.assertEqual(media, ["https://h/a.png", "https://h/v.mp4"])

    def test_pre_keeps_whitespace(self):
        nodes, _ = wm.html_to_nodes("<pre><code>a\n  b\n</code></pre><ul>\n<li>x</li>\n</ul>")
        self.assertEqual(nodes[0], {"t": "pre", "c": [{"t": "code", "c": ["a\n  b\n"]}]})
        self.assertEqual(nodes[1], {"t": "ul", "c": [{"t": "li", "c": ["x"]}]})

    def test_unwraps_link_around_image(self):
        nodes, _ = wm.html_to_nodes(
            '<p><a href="https://h/a.png"><img src="https://h/a.png" alt="A"></a></p>'
        )
        self.assertEqual(
            nodes, [{"t": "p", "c": [{"t": "img", "a": {"src": "https://h/a.png", "alt": "A"}}]}]
        )

    def test_github_video_details_unwrapped(self):
        nodes, _ = wm.html_to_nodes(
            '<details open class="x"><summary><span>demo.mp4</span></summary>'
            '<video src="https://h/v.mp4" controls="controls"></video></details>'
            "<details><summary>More</summary><p>text</p></details>"
        )
        self.assertEqual(
            nodes[0], {"t": "video", "a": {"src": "https://h/v.mp4", "controls": True}}
        )
        self.assertEqual(nodes[1]["t"], "details")  # a real disclosure stays


class SelectionTest(unittest.TestCase):
    def test_numeric_order_skips_drafts_and_other_streams(self):
        picked = wm.select_releases(load_fixture(), wm.APP_TAG, 10)
        self.assertEqual(
            [r["tag_name"] for r in picked], ["app-v1.10.0", "app-v1.9.10", "app-v1.9.2"]
        )

    def test_limit_and_up_to(self):
        rel = load_fixture()
        self.assertEqual(
            [r["tag_name"] for r in wm.select_releases(rel, wm.APP_TAG, 1)], ["app-v1.10.0"]
        )
        capped = wm.select_releases(rel, wm.APP_TAG, 10, up_to="app-v1.9.10")
        self.assertEqual([r["tag_name"] for r in capped], ["app-v1.9.10", "app-v1.9.2"])

    def test_up_to_draft_is_included(self):
        # The Release workflow mirrors its own (still draft) release before publishing it.
        picked = wm.select_releases(load_fixture(), wm.APP_TAG, 10, up_to="app-v1.11.0")
        self.assertEqual(picked[0]["tag_name"], "app-v1.11.0")
        idx = wm.build_index(
            load_fixture(),
            tempfile.mkdtemp() + "/w",
            FakeNet(),
            up_to="app-v1.11.0",
            log=lambda m: None,
        )
        self.assertEqual(
            idx["releases"][0]["url"], "https://github.com/fughilli/splanc/releases/tag/app-v1.11.0"
        )

    def test_up_to_drops_later_firmware(self):
        app, fw = wm.select_all(load_fixture(), 10, 3, up_to="app-v1.9.10")
        self.assertEqual(fw, [])  # firmware 1.9.0 was published after app 1.9.10
        app, fw = wm.select_all(load_fixture(), 10, 3)
        self.assertEqual([r["tag_name"] for r in fw], ["firmware-v1.9.0"])

    def test_digest_tracks_edits(self):
        rel = load_fixture()
        before = wm.digest(*wm.select_all(rel, 10, 3))
        self.assertEqual(before, wm.digest(*wm.select_all(load_fixture(), 10, 3)))
        rel[1]["body"] += "\nEdited."
        self.assertNotEqual(before, wm.digest(*wm.select_all(rel, 10, 3)))
        rel = load_fixture()
        rel[1]["assets"].append(
            {"id": 103, "name": "new.webp", "content_type": "image/webp", "updated_at": "x"}
        )
        self.assertNotEqual(before, wm.digest(*wm.select_all(rel, 10, 3)))


class MirrorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "site", "whatsnew")
        self.net = FakeNet()
        self.logs = []
        self.index = wm.build_index(
            load_fixture(), self.out, self.net, now="2026-11-16T00:00:00Z", log=self.logs.append
        )
        self.rel = self.index["releases"][0]

    def test_index_shape(self):
        with open(os.path.join(self.out, "index.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk, self.index)
        self.assertEqual(self.index["schema"], 1)
        self.assertEqual(
            [r["version"] for r in self.index["releases"]], ["1.10.0", "1.9.10", "1.9.2"]
        )
        self.assertEqual([r["version"] for r in self.index["firmware"]], ["1.9.0"])
        self.assertTrue(self.index["releases"][2]["prerelease"])
        self.assertEqual(self.rel["date"], "2026-11-12T08:00:00Z")
        self.assertEqual(self.rel["name"], "Splanc 1.10.0")
        self.assertTrue(self.index["digest"].startswith("sha256:"))

    def test_media_rewritten_to_local_files(self):
        media = [
            n for n in walk(self.rel["body"]) if isinstance(n, dict) and n["t"] in ("img", "video")
        ]
        srcs = [n["a"]["src"] for n in media]
        self.assertEqual(len(srcs), 3)  # body image, body video, gallery asset
        for src in srcs:
            self.assertRegex(src, r"^media/[0-9a-f]{20}\.(png|mp4)$")
            self.assertTrue(os.path.isfile(os.path.join(self.out, src)))
        self.assertEqual(sorted(set(srcs)), self.rel["media"])
        with open(os.path.join(self.out, srcs[0]), "rb") as f:
            self.assertEqual(f.read(), PNG)
        self.assertEqual(media[0]["a"]["alt"], "New editor")
        self.assertEqual(media[0]["a"]["width"], 640)
        self.assertTrue(srcs[1].endswith(".mp4"))
        self.assertEqual(media[2]["a"]["alt"], "light show")  # gallery asset, from its file name
        # The .tar.gz asset is not media and is never fetched.
        self.assertFalse(any(u.endswith(".tar.gz") for u in self.net.calls))
        # Each URL is fetched once even though the body links it twice.
        self.assertEqual(
            self.net.calls.count("https://github.com/user-attachments/assets/aaaa-1111"), 1
        )

    def test_no_remote_media_or_unsafe_content_left(self):
        blob = json.dumps(self.index)
        self.assertNotIn(
            "user-attachments",
            json.dumps(
                [
                    n
                    for n in walk(self.rel["body"])
                    if isinstance(n, dict) and n["t"] in ("img", "video")
                ]
            ),
        )
        for bad in (
            "<script",
            "alert('xss')",
            "onerror",
            "onclick",
            "javascript:",
            "style",
            "inside iframe",
            "data:image",
        ):
            self.assertNotIn(bad, blob)

    def test_failed_download_becomes_link(self):
        links = [n for n in walk(self.rel["body"]) if isinstance(n, dict) and n["t"] == "a"]
        broken = [n for n in links if n["a"]["href"] == "https://camo.githubusercontent.com/broken"]
        self.assertEqual(broken[0]["c"], ["Broken pic"])
        self.assertTrue(any("camo.githubusercontent.com/broken" in m for m in self.logs))

    def test_task_list_and_text_fallback(self):
        self.assertIn("☑ Done thing", text_of(self.rel["body"]))
        plain = self.index["releases"][1]["body"]
        self.assertEqual(
            plain, [{"t": "p", "c": ["Plain text only"]}, {"t": "p", "c": ["Second paragraph"]}]
        )

    def test_rerun_replaces_output(self):
        stale = os.path.join(self.out, "media", "stale.png")
        with open(stale, "wb") as f:
            f.write(b"old")
        wm.build_index(load_fixture(), self.out, FakeNet(), log=self.logs.append)
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "index.json")))
        leftovers = [d for d in os.listdir(os.path.dirname(self.out)) if d.startswith(".whatsnew-")]
        self.assertEqual(leftovers, [])

    def test_cli_offline(self):
        fixture = os.path.join(HERE, "testdata", "releases.json")
        out = os.path.join(self.tmp, "cli")
        # No network: every media fetch fails, so media degrade to links; the
        # index is still written.
        orig = wm.http_fetcher
        wm.http_fetcher = lambda token: FakeNet()
        try:
            self.assertEqual(
                wm.main(["--releases-json", fixture, "--out", out, "--up-to", "app-v1.9.10"]), 0
            )
        finally:
            wm.http_fetcher = orig
        with open(os.path.join(out, "index.json")) as f:
            idx = json.load(f)
        self.assertEqual([r["version"] for r in idx["releases"]], ["1.9.10", "1.9.2"])


if __name__ == "__main__":
    unittest.main()
