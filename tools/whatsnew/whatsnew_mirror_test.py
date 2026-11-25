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
        picked = wm.select_releases(load_fixture(), wm.APP_TAG)
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

    def test_an_untagged_draft_is_matched_by_name_once(self):
        # GitHub reports a draft's tag as untagged-<id> once another release claims
        # the tag (app-v1.17.0): match it by name, keep the newest draft only, and
        # a published release beats any draft.
        rows = [
            {"tag_name": "untagged-aa", "name": "app-v1.17.0", "draft": True, "created_at": "2026-11-23T00:00:00Z"},
            {"tag_name": "untagged-bb", "name": "app-v1.17.0", "draft": True, "created_at": "2026-11-25T00:00:00Z"},
            {"tag_name": "app-v1.16.0", "name": "app-v1.16.0", "draft": False},
        ]  # fmt: skip
        picked = wm.select_releases(rows, wm.APP_TAG, 10, up_to="app-v1.17.0")
        self.assertEqual([r["tag_name"] for r in picked], ["app-v1.17.0", "app-v1.16.0"])
        self.assertEqual(picked[0]["created_at"], "2026-11-25T00:00:00Z")
        self.assertEqual([r["tag_name"] for r in wm.select_releases(rows, wm.APP_TAG, 10)], ["app-v1.16.0"])
        rows.append({"tag_name": "app-v1.17.0", "name": "app-v1.17.0", "draft": False, "created_at": "2026-11-20T00:00:00Z"})
        picked = wm.select_releases(rows, wm.APP_TAG, 10, up_to="app-v1.17.0")
        self.assertEqual([(r["tag_name"], r["draft"]) for r in picked], [("app-v1.17.0", False), ("app-v1.16.0", False)])

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
            idx["notes"]["app"]["releases"][0]["url"],
            "https://github.com/fughilli/splanc/releases/tag/app-v1.11.0",
        )

    def test_products_by_tag_prefix(self):
        got = [(p.id, [r["tag_name"] for r in rows]) for p, rows in wm.select_all(load_fixture())]
        self.assertEqual(
            got,
            [
                ("app", ["app-v1.10.0", "app-v1.9.10", "app-v1.9.2"]),
                ("firmware", ["firmware-v1.9.0", "firmware-v1.8.0"]),
                # pi-bridge-ota-v1.1.0, fxbench-data and stage-demo are no product.
                ("bridge", ["pi-bridge-v1.0.0"]),
            ],
        )

    def test_product_table(self):
        ids = [p.id for p in wm.PRODUCTS]
        self.assertEqual(ids[0], "app")
        self.assertEqual(len(ids), len(set(ids)))
        for p in wm.PRODUCTS:
            self.assertRegex(p.id, r"^[a-z0-9-]+$")
        bridge = next(p for p in wm.PRODUCTS if p.id == "bridge")
        self.assertTrue(bridge.pattern.match("pi-bridge-v1.1.0"))
        self.assertFalse(bridge.pattern.match("pi-bridge-ota-v1.1.0"))
        self.assertFalse(bridge.pattern.match("pi-bridge-ota"))

    def test_up_to_drops_later_products(self):
        got = {p.id: rows for p, rows in wm.select_all(load_fixture(), up_to="app-v1.9.10")}
        # firmware 1.9.0 was published after app 1.9.10; 1.8.0 and the bridge before.
        self.assertEqual([r["tag_name"] for r in got["firmware"]], ["firmware-v1.8.0"])
        self.assertEqual([r["tag_name"] for r in got["bridge"]], ["pi-bridge-v1.0.0"])
        got = {p.id for p, _ in wm.select_all(load_fixture(), up_to="app-v1.9.2")}
        self.assertEqual(got, {"app", "firmware", "bridge"})
        # A product with no releases is left out of the list entirely.
        rel = [r for r in load_fixture() if not r["tag_name"].startswith("pi-bridge-v")]
        self.assertEqual([p.id for p, _ in wm.select_all(rel)], ["app", "firmware"])

    def test_digest_tracks_edits(self):
        rel = load_fixture()
        before = wm.digest(wm.select_all(rel))
        self.assertEqual(before, wm.digest(wm.select_all(load_fixture())))
        rel[1]["body"] += "\nEdited."
        self.assertNotEqual(before, wm.digest(wm.select_all(rel)))
        rel = load_fixture()
        rel[1]["assets"].append(
            {"id": 103, "name": "new.webp", "content_type": "image/webp", "updated_at": "x"}
        )
        self.assertNotEqual(before, wm.digest(wm.select_all(rel)))
        # Bridge notes are part of the fingerprint too.
        rel = load_fixture()
        next(r for r in rel if r["tag_name"] == "pi-bridge-v1.0.0")["body"] = "Edited."
        self.assertNotEqual(before, wm.digest(wm.select_all(rel)))


class MirrorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "site", "whatsnew")
        self.net = FakeNet()
        self.logs = []
        self.index = wm.build_index(
            load_fixture(), self.out, self.net, now="2026-11-16T00:00:00Z", log=self.logs.append
        )
        self.app = self.index["notes"]["app"]["releases"]
        self.rel = self.app[0]

    def read(self, name):
        with open(os.path.join(self.out, name)) as f:
            return json.load(f)

    def test_index_shape(self):
        on_disk = self.read("index.json")
        self.assertEqual(on_disk, {k: v for k, v in self.index.items() if k != "notes"})
        self.assertEqual(on_disk["schema"], 2)
        self.assertNotIn("releases", on_disk)  # notes live in the per-product files
        self.assertEqual(
            on_disk["products"],
            [
                {
                    "id": "app",
                    "name": "Splanc app",
                    "label": "Splanc",
                    "file": "app.json",
                    "count": 3,
                    "latest": {"version": "1.10.0", "date": "2026-11-12T08:00:00Z"},
                },
                {
                    "id": "firmware",
                    "name": "Firmware",
                    "label": "Firmware",
                    "file": "firmware.json",
                    "count": 2,
                    "latest": {"version": "1.9.0", "date": "2026-11-10T10:00:00Z"},
                },
                {
                    "id": "bridge",
                    "name": "Bridge",
                    "label": "Bridge",
                    "file": "bridge.json",
                    "count": 1,
                    "latest": {"version": "1.0.0", "date": "2026-11-01T08:00:00Z"},
                },
            ],
        )
        self.assertTrue(on_disk["digest"].startswith("sha256:"))

    def test_product_files(self):
        for product in self.index["products"]:
            body = self.read(product["file"])
            self.assertEqual(body, self.index["notes"][product["id"]])
            self.assertEqual(body["schema"], 2)
            self.assertEqual(body["product"], product["id"])
            self.assertEqual(len(body["releases"]), product["count"])
        self.assertEqual([r["version"] for r in self.app], ["1.10.0", "1.9.10", "1.9.2"])
        fw = self.read("firmware.json")["releases"]
        self.assertEqual([r["version"] for r in fw], ["1.9.0", "1.8.0"])
        bridge = self.read("bridge.json")["releases"]
        self.assertEqual(bridge[0]["tag"], "pi-bridge-v1.0.0")
        self.assertEqual(bridge[0]["name"], "Splanc bridge 1.0.0")
        self.assertTrue(self.app[2]["prerelease"])
        self.assertEqual(self.rel["date"], "2026-11-12T08:00:00Z")
        self.assertEqual(self.rel["name"], "Splanc 1.10.0")
        self.assertEqual(
            sorted(os.listdir(self.out)),
            ["app.json", "bridge.json", "firmware.json", "index.json", "media"],
        )

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
        # Each URL is fetched once even though the body links it twice and an
        # older firmware release shows it too: media are shared across products.
        self.assertEqual(
            self.net.calls.count("https://github.com/user-attachments/assets/aaaa-1111"), 1
        )
        fw_old = self.index["notes"]["firmware"]["releases"][1]
        self.assertEqual(fw_old["media"], [srcs[0]])

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
        plain = self.app[1]["body"]
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
        with open(os.path.join(out, "app.json")) as f:
            app = json.load(f)
        self.assertEqual([r["version"] for r in app["releases"]], ["1.9.10", "1.9.2"])
        with open(os.path.join(out, "index.json")) as f:
            idx = json.load(f)
        self.assertEqual([p["count"] for p in idx["products"]], [2, 1, 1])
        with open(os.path.join(out, "firmware.json")) as f:
            fw = json.load(f)
        self.assertEqual([r["tag"] for r in fw["releases"]], ["firmware-v1.8.0"])

    def test_cli_limit_per_product(self):
        fixture = os.path.join(HERE, "testdata", "releases.json")
        out = os.path.join(self.tmp, "cli1")
        orig = wm.http_fetcher
        wm.http_fetcher = lambda token: FakeNet()
        try:
            self.assertEqual(wm.main(["--releases-json", fixture, "--out", out, "--limit", "1"]), 0)
        finally:
            wm.http_fetcher = orig
        with open(os.path.join(out, "index.json")) as f:
            idx = json.load(f)
        self.assertEqual([p["count"] for p in idx["products"]], [1, 1, 1])


class ClipsTest(unittest.TestCase):
    """preview-clips.json (tools/release_clips) becomes the release's `clips`;
    the GIF section and the clip assets don't show twice."""

    API = "https://api.github.com/repos/fughilli/splanc/releases/assets/"
    DL = "https://github.com/fughilli/splanc/releases/download/app-v1.11.0/"

    def release(self, draft):
        names = ["preview-clips.json", "ai-tab-phone.mp4", "ai-tab-phone.webm", "ai-tab-phone.jpg",
                 "ai-tab-phone.gif", "screenshot.png"]  # fmt: skip
        assets = [
            {"id": i, "name": n, "url": self.API + str(i), "browser_download_url": self.DL + n,
             "content_type": {"json": "application/json", "mp4": "video/mp4", "webm": "video/webm",
                              "jpg": "image/jpeg", "gif": "image/gif", "png": "image/png"}[n.rsplit(".", 1)[1]],
             "updated_at": "2026-11-20T00:00:00Z"}
            for i, n in enumerate(names, start=1)
        ]  # fmt: skip
        gif = self.DL + "ai-tab-phone.gif"
        return {
            "tag_name": "app-v1.11.0", "name": "app-v1.11.0", "draft": draft, "prerelease": False,
            "published_at": None if draft else "2026-11-20T00:00:00Z", "created_at": "2026-11-20T00:00:00Z",
            "body_html": '<h2>Feature previews</h2><h3>AI tab</h3><p><a href="' + gif + '"><img src="' + gif
            + '" alt="AI tab"></a></p><p>Pick where AI runs.</p>'
            + "<h2>What's Changed</h2><ul><li>AI tab by x in #558</li></ul>",
            "assets": assets,
        }  # fmt: skip

    def net(self, draft):
        manifest = {
            "schema": 1, "tag": "app-v1.11.0",
            "clips": [{"id": "ai-tab", "title": "AI tab", "summary": "Pick where AI runs.", "prs": [558],
                       "variants": [{"framing": "phone", "mp4": "ai-tab-phone.mp4", "webm": "ai-tab-phone.webm",
                                     "poster": "ai-tab-phone.jpg", "gif": "ai-tab-phone.gif",
                                     "width": 600, "height": 1298, "duration": 9.5}]},
                      {"id": "broken", "title": "No video", "summary": "x",
                       "variants": [{"framing": "phone", "mp4": "missing.mp4"}]}],
        }  # fmt: skip
        base = self.API if draft else self.DL
        key = (lambda i, n: self.API + str(i)) if draft else (lambda i, n: self.DL + n)
        files = {
            key(1, "preview-clips.json"): (json.dumps(manifest).encode(), "application/json"),
            key(2, "ai-tab-phone.mp4"): (MP4, "video/mp4"),
            key(3, "ai-tab-phone.webm"): (MP4 + b"w", "video/webm"),
            key(4, "ai-tab-phone.jpg"): (PNG + b"j", "image/jpeg"),
            key(5, "ai-tab-phone.gif"): (PNG + b"g", "image/gif"),
            key(6, "screenshot.png"): (PNG + b"s", "image/png"),
        }
        net = FakeNet()
        net.files = files
        self.assertTrue(base)
        return net

    def mirror(self, draft):
        net = self.net(draft)
        media = wm.MediaStore(tempfile.mkdtemp(), net, lambda m: None)
        return wm.mirror_release(self.release(draft), wm.APP.pattern, media, "fughilli/splanc"), net

    def check(self, r):
        self.assertEqual([c["id"] for c in r["clips"]], ["ai-tab"])  # no-MP4 clip dropped
        v = r["clips"][0]["variants"][0]
        self.assertEqual(v["framing"], "phone")
        self.assertEqual((v["width"], v["height"]), (600, 1298))
        for k in ("mp4", "webm", "poster"):
            self.assertRegex(v[k], r"^media/[0-9a-f]{20}\.(mp4|webm|jpg)$")
            self.assertIn(v[k], r["media"])
        self.assertEqual(r["clips"][0]["prs"], [558])
        # The GIF section is gone, the rest of the notes stay.
        self.assertNotIn("Feature previews", text_of(r["body"]))
        self.assertNotIn("Pick where AI runs.", text_of(r["body"]))
        self.assertIn("What's Changed", text_of(r["body"]))
        # The gallery keeps unrelated media only (no GIF, MP4, manifest).
        srcs = [
            n["a"]["src"]
            for n in walk(r["body"])
            if isinstance(n, dict) and n["t"] in ("img", "video")
        ]
        self.assertEqual(len(srcs), 1)
        self.assertNotIn(srcs[0], (v["mp4"], v["webm"], v["poster"]))

    def test_published_release(self):
        r, net = self.mirror(draft=False)
        self.check(r)
        self.assertFalse(any(u.startswith(self.API) for u in net.calls))

    def test_draft_release_reads_assets_through_the_api(self):
        r, net = self.mirror(draft=True)
        self.check(r)
        self.assertFalse(any(u.startswith(self.DL) for u in net.calls))

    def test_no_manifest_keeps_the_body(self):
        rel = self.release(False)
        rel["assets"] = [a for a in rel["assets"] if a["name"] != "preview-clips.json"]
        media = wm.MediaStore(tempfile.mkdtemp(), self.net(False), lambda m: None)
        r = wm.mirror_release(rel, wm.APP.pattern, media, "fughilli/splanc")
        self.assertNotIn("clips", r)
        self.assertIn("Feature previews", text_of(r["body"]))

    def test_bad_manifest_is_ignored(self):
        net = self.net(False)
        net.files[self.DL + "preview-clips.json"] = (b"{nope", "application/json")
        media = wm.MediaStore(tempfile.mkdtemp(), net, lambda m: None)
        logs = []
        r = wm.mirror_release(
            self.release(False), wm.APP.pattern, media, "fughilli/splanc", log=logs.append
        )
        self.assertNotIn("clips", r)
        self.assertTrue(any("unreadable preview-clips.json" in m for m in logs))

    def test_manifest_changes_the_digest(self):
        rel = self.release(False)
        before = wm.digest([(wm.APP, [rel])])
        next(a for a in rel["assets"] if a["name"] == "preview-clips.json")[
            "updated_at"
        ] = "2026-11-21T00:00:00Z"
        self.assertNotEqual(before, wm.digest([(wm.APP, [rel])]))


if __name__ == "__main__":
    unittest.main()
