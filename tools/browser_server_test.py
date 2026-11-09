"""Tests for the debug server's diagnostics intake (tools/browser_server.py, #450):
capture-bundle persistence + enumeration, idempotent re-sends, manifest
received/missing reports, and the ids acks on /effects and /chatlogs.

Runs the real Handler on an ephemeral localhost port (plain HTTP) with the
store directory in a temp dir. No Playwright needed (imported lazily).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import browser_server as bs


def _bundle(
    ident: str, fmt: str = "splanc-capture-bundle", outcome: str = "failed", **extra
) -> dict:
    b = {
        "format": fmt,
        "version": 1,
        "id": ident,
        "createdAt": f"2026-11-04T19:{len(ident):02d}:00.000Z",
        "outcome": outcome,
        "summary": f"{outcome}: test",
        "capture": {"ledCount": 8},
        "problem": {"detections": [{"ledId": 1, "u": 1.5}]},
        "frames": [],
    }
    b.update(extra)
    return b


class IntakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        bs._STORE["dir"] = os.path.join(self.tmp.name, "store")
        bs._EFFECTS_FILE = os.path.join(self.tmp.name, "effects.json")
        bs._CHATLOGS_FILE = os.path.join(self.tmp.name, "chatlogs.json")
        bs._EFFECTS_LIB.update(library=None, at=None)
        bs._CHATLOGS.update(sessions={}, at=None)
        bs._log = lambda _m: None
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), bs.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def req(self, path: str, body: bytes | None = None):
        r = urllib.request.Request(
            self.base + path, data=body, method="POST" if body is not None else "GET"
        )
        r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=10) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def post_bundle(self, b: dict, snapshot: str = "s1"):
        raw = json.dumps(b, separators=(",", ":")).encode()
        return raw, self.req(f"/capturebundles?snapshot={snapshot}", raw)

    def test_eight_bundles_are_persisted_and_enumerable(self) -> None:
        sent = {}
        for i in range(8):
            fmt = "splanc-localize-bundle" if i % 3 == 2 else "splanc-capture-bundle"
            b = _bundle(f"b{i}", fmt=fmt, outcome="failed" if i % 2 else "ok")
            raw, (code, ack) = self.post_bundle(b)
            self.assertEqual(code, 200, ack)
            self.assertEqual(ack["status"], "stored")
            self.assertEqual(ack["sha256"], hashlib.sha256(raw).hexdigest())
            sent[b["id"]] = b
        code, listing = self.req("/capturebundles")
        self.assertEqual(code, 200)
        self.assertEqual(listing["count"], 8)
        self.assertEqual({r["id"] for r in listing["bundles"]}, set(sent))
        kinds = {r["id"]: r["kind"] for r in listing["bundles"]}
        self.assertEqual(kinds["b2"], "localization")
        self.assertEqual(kinds["b0"], "mapping")
        for ident, b in sent.items():
            code, got = self.req(f"/capturebundles?id={ident}")
            self.assertEqual(code, 200)
            self.assertEqual(got, b, "stored bundle is the replayable original")

    def test_resend_is_idempotent_and_changed_bytes_replace(self) -> None:
        b = _bundle("dup")
        self.post_bundle(b, "s1")
        _, (_, again) = self.post_bundle(b, "s2")
        self.assertEqual(again["status"], "duplicate")
        b2 = dict(b, summary="changed")
        _, (_, rep) = self.post_bundle(b2, "s3")
        self.assertEqual(rep["status"], "replaced")
        _, listing = self.req("/capturebundles")
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["bundles"][0]["snapshots"], ["s1", "s2", "s3"])

    def test_backup_encoded_values_are_decoded_like_the_app(self) -> None:
        # encodeValue tags NaN and undefined; the stored file must look like
        # JSON.stringify(decodeValue(x)): NaN -> null, undefined field dropped.
        b = _bundle("enc", final={"rms": {"$b": "num", "v": "NaN"}, "note": {"$b": "undef"}})
        b["problem"]["detections"].append({"$b": "obj", "v": {"$b": 1, "u": 2}})
        self.post_bundle(b)
        _, got = self.req("/capturebundles?id=enc")
        self.assertEqual(got["final"], {"rms": None})
        self.assertEqual(got["problem"]["detections"][1], {"$b": 1, "u": 2})

    def test_rejects_non_bundles_and_bad_json(self) -> None:
        code, err = self.req("/capturebundles", b"{nope")
        self.assertEqual(code, 400)
        code, err = self.req("/capturebundles", json.dumps({"format": "x", "id": "a"}).encode())
        self.assertEqual(code, 400)
        self.assertIn("not a capture", err["error"])
        code, _ = self.req("/capturebundles?id=missing")
        self.assertEqual(code, 404)

    def test_bundles_survive_a_restart(self) -> None:
        self.post_bundle(_bundle("keep"))
        # A fresh process has no in-memory state; the index is on disk.
        _, listing = self.req("/capturebundles")
        self.assertEqual([r["id"] for r in listing["bundles"]], ["keep"])
        self.assertTrue(
            os.path.exists(os.path.join(bs._STORE["dir"], "capturebundles", "keep.json"))
        )

    def test_hostile_ids_stay_inside_the_store(self) -> None:
        _, (code, ack) = self.post_bundle(_bundle("../../etc/passwd"))
        self.assertEqual(code, 200)
        files = os.listdir(os.path.join(bs._STORE["dir"], "capturebundles"))
        self.assertTrue(all("/" not in f for f in files))
        _, got = self.req("/capturebundles?id=" + urllib.request.quote("../../etc/passwd", safe=""))
        self.assertEqual(got["id"], "../../etc/passwd")

    def test_effects_and_chatlogs_ack_ids(self) -> None:
        _, ack = self.req(
            "/effects", json.dumps({"effects": [{"id": "e1"}, {"id": "e2"}]}).encode()
        )
        self.assertEqual(ack["ids"], ["e1", "e2"])
        _, ack = self.req("/chatlogs", json.dumps({"sessions": [{"id": "c1"}]}).encode())
        self.assertEqual(ack["ids"], ["c1"])

    def test_manifest_report_tracks_received_and_missing(self) -> None:
        raw_a, _ = self.post_bundle(_bundle("a"))
        man = {
            "snapshotId": "snap-1",
            "createdAt": "2026-11-09T00:00:00Z",
            "categories": {
                "effects": {"count": 1, "items": [{"id": "e1"}]},
                "chatlogs": {"count": 1, "items": [{"id": "c1"}]},
                "captures": {
                    "count": 2,
                    "items": [
                        {"id": "a", "sha256": hashlib.sha256(raw_a).hexdigest()},
                        {"id": "b", "sha256": "0" * 64},
                    ],
                },
            },
        }
        code, ack = self.req("/diagnostics", json.dumps(man).encode())
        self.assertEqual((code, ack["snapshotId"]), (200, "snap-1"))
        _, rep = self.req("/diagnostics?id=snap-1")
        self.assertFalse(rep["complete"])
        self.assertEqual(rep["report"]["captures"]["received"], ["a"])
        self.assertEqual(rep["report"]["captures"]["missing"], ["b"])
        self.assertEqual(rep["report"]["effects"]["missing"], ["e1"])
        self.req("/effects", json.dumps({"effects": [{"id": "e1"}]}).encode())
        self.req("/chatlogs", json.dumps({"sessions": [{"id": "c1"}]}).encode())
        self.post_bundle(_bundle("b"))
        _, rep = self.req("/diagnostics?id=snap-1")
        self.assertEqual(rep["report"]["effects"]["received"], ["e1"])
        self.assertEqual(
            rep["report"]["captures"]["missing"], ["b"], "wrong checksum is not received"
        )
        _, listing = self.req("/diagnostics")
        self.assertEqual(
            listing["snapshots"][0]["counts"], {"effects": 1, "chatlogs": 1, "captures": 2}
        )

    def test_oversized_body_is_refused(self) -> None:
        old = bs.MAX_BODY_BYTES
        bs.MAX_BODY_BYTES = 10
        try:
            code, err = self.req("/capturebundles", json.dumps(_bundle("big")).encode())
        except (ConnectionError, urllib.error.URLError):
            code, err = 413, {"error": "connection closed"}
        finally:
            bs.MAX_BODY_BYTES = old
        self.assertEqual(code, 413, err)


if __name__ == "__main__":
    unittest.main()
