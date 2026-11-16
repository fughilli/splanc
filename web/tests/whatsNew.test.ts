/**
 * "What's new?" (release notes card): version order, when the sparkle bubble
 * shows (fresh install, update, skipped versions, after it was seen, a PWA
 * pull-to-refresh into a new deploy, play-mode launches), which notes a card
 * lists, and the allowlist the mirrored notes pass before reaching the DOM.
 *
 * testdata/whatsnew-index.json is what tools/whatsnew/whatsnew_mirror.py emits
 * for its own fixture releases (tools/whatsnew/testdata/releases.json).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  cardContent,
  compareVersions,
  deserializeWhatsNewState,
  parseIndex,
  parseReleaseVersion,
  planBoot,
  sanitizeNotes,
  serializeWhatsNewState,
  type WhatsNewState,
} from "../src/ui/whatsnew/model";
import indexJson from "./testdata/whatsnew-index.json";

const st = (lastSeen: string | null): WhatsNewState => ({ lastSeen });

describe("versions", () => {
  test("only plain release versions parse", () => {
    assert.deepEqual(parseReleaseVersion("1.14.1"), [1, 14, 1]);
    assert.deepEqual(parseReleaseVersion("v2.0.0"), [2, 0, 0]);
    for (const v of ["0.0.0-dev", "1.14.1-5-gabc1234", "", "1.2", "x.y.z", undefined, null]) {
      assert.equal(parseReleaseVersion(v), null, String(v));
    }
  });

  test("numeric order, not string order", () => {
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.ok(compareVersions("1.9.10", "1.9.2") > 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.ok(compareVersions("1.0.0", "garbage") > 0);
  });
});

describe("state storage", () => {
  test("round-trips and tolerates junk", () => {
    assert.deepEqual(deserializeWhatsNewState(serializeWhatsNewState(st("1.2.3"))), st("1.2.3"));
    for (const raw of [null, "", "{", "null", "[]", '{"lastSeen":5}', '{"lastSeen":"0.0.0-dev"}']) {
      assert.deepEqual(deserializeWhatsNewState(raw), st(null), String(raw));
    }
  });
});

describe("planBoot (sparkle bubble visibility)", () => {
  const base = { priorUse: true, suppressed: false };

  test("fresh install: no bubble, version remembered (the tour hint owns the launch)", () => {
    const p = planBoot({ ...base, priorUse: false, state: st(null), current: "1.14.1" });
    assert.deepEqual(p, { bubble: false, since: null, save: st("1.14.1") });
    // The next launch of the same version: still nothing.
    assert.equal(planBoot({ ...base, state: p.save!, current: "1.14.1" }).bubble, false);
  });

  test("update: bubble on the first open, notes since the last-seen version", () => {
    const p = planBoot({ ...base, state: st("1.14.0"), current: "1.14.1" });
    assert.deepEqual(p, { bubble: true, since: "1.14.0", save: st("1.14.1") });
  });

  test("after that first open (or a relaunch) the bubble is gone", () => {
    const first = planBoot({ ...base, state: st("1.14.0"), current: "1.14.1" });
    const again = planBoot({ ...base, state: first.save!, current: "1.14.1" });
    assert.deepEqual(again, { bubble: false, since: null, save: null });
  });

  test("several skipped versions: one bubble, since the oldest seen", () => {
    const p = planBoot({ ...base, state: st("1.9.2"), current: "1.14.1" });
    assert.equal(p.bubble, true);
    assert.equal(p.since, "1.9.2");
  });

  test("PWA pull-to-refresh into a new deploy = a launch of the new version", () => {
    // Session 1 ran 1.14.0 (state recorded); the drag-refresh reloads the page,
    // the network-first navigation brings the 1.14.1 bundle, and boot runs again.
    const s1 = planBoot({ ...base, state: st("1.13.1"), current: "1.14.0" });
    const refresh = planBoot({ ...base, state: s1.save!, current: "1.14.1" });
    assert.deepEqual(refresh, { bubble: true, since: "1.14.0", save: st("1.14.1") });
    // A refresh that brought no new version shows nothing.
    assert.equal(planBoot({ ...base, state: refresh.save!, current: "1.14.1" }).bubble, false);
  });

  test("update from a build before this feature (no record, but used before)", () => {
    assert.deepEqual(planBoot({ ...base, state: st(null), current: "1.15.0" }), {
      bubble: true,
      since: null,
      save: st("1.15.0"),
    });
  });

  test("dev / main / preview builds never show it and leave storage alone", () => {
    for (const current of ["0.0.0-dev", "1.14.1-3-gdeadbee", undefined]) {
      assert.deepEqual(planBoot({ ...base, state: st("1.14.0"), current }), {
        bubble: false,
        since: null,
        save: null,
      });
    }
  });

  test("rollback: no bubble, the higher mark is kept", () => {
    assert.deepEqual(planBoot({ ...base, state: st("1.14.1"), current: "1.14.0" }), {
      bubble: false,
      since: null,
      save: null,
    });
  });

  test("a suppressed launch (play mode) defers the update without consuming it", () => {
    const p = planBoot({ ...base, suppressed: true, state: st("1.14.0"), current: "1.14.1" });
    assert.deepEqual(p, { bubble: false, since: null, save: null });
    assert.equal(planBoot({ ...base, state: st("1.14.0"), current: "1.14.1" }).bubble, true);
    // A fresh install in play mode still records the version.
    assert.deepEqual(planBoot({ priorUse: false, suppressed: true, state: st(null), current: "1.14.1" }).save, st("1.14.1"));
  });
});

describe("parseIndex + cardContent", () => {
  const index = parseIndex(indexJson)!;

  test("the mirror's fixture output parses, newest first", () => {
    assert.ok(index);
    assert.deepEqual(index.releases.map((r) => r.version), ["1.10.0", "1.9.10", "1.9.2"]);
    assert.deepEqual(index.firmware.map((r) => r.version), ["1.9.0"]);
    assert.equal(index.releases[0]!.name, "Splanc 1.10.0");
    assert.equal(index.releases[0]!.media.length, 3);
  });

  test("rejects a missing or incompatible index", () => {
    assert.equal(parseIndex(null), null);
    assert.equal(parseIndex({ schema: 2, releases: [] }), null);
    assert.equal(parseIndex("nope"), null);
  });

  test("since: every skipped version up to the running one", () => {
    const c = cardContent(index, "1.10.0", { kind: "since", since: "1.9.2" });
    assert.deepEqual(c.primary.map((r) => r.version), ["1.10.0", "1.9.10"]);
    assert.equal(c.missingCurrent, false);
    assert.deepEqual(c.earlier, []);
  });

  test("since: firmware released after the last-seen app release", () => {
    // 1.9.2 went out 11-05, firmware 1.9.0 on 11-10 → news.
    assert.deepEqual(cardContent(index, "1.10.0", { kind: "since", since: "1.9.2" }).firmware.map((r) => r.version), ["1.9.0"]);
    // 1.10.0 went out 11-12, after the firmware → not news.
    assert.deepEqual(cardContent(index, "1.10.0", { kind: "since", since: "1.10.0" }).firmware, []);
  });

  test("since null (update from a pre-feature build): the current version only", () => {
    const c = cardContent(index, "1.9.10", { kind: "since", since: null });
    assert.deepEqual(c.primary.map((r) => r.version), ["1.9.10"]);
    assert.deepEqual(c.firmware.map((r) => r.version), ["1.9.0"]);
  });

  test("never lists releases newer than the running build", () => {
    const c = cardContent(index, "1.9.10", { kind: "since", since: "1.9.2" });
    assert.deepEqual(c.primary.map((r) => r.version), ["1.9.10"]);
    const h = cardContent(index, "1.9.10", { kind: "history" });
    assert.deepEqual(h.primary.map((r) => r.version), ["1.9.10"]);
    assert.deepEqual(h.earlier.map((r) => r.version), ["1.9.2"]);
  });

  test("history (About): current version, then the rest", () => {
    const h = cardContent(index, "1.10.0", { kind: "history" });
    assert.deepEqual(h.primary.map((r) => r.version), ["1.10.0"]);
    assert.deepEqual(h.earlier.map((r) => r.version), ["1.9.10", "1.9.2"]);
    assert.deepEqual(h.firmware.map((r) => r.version), ["1.9.0"]);
  });

  test("running version not mirrored yet, or no index at all", () => {
    const c = cardContent(index, "1.11.0", { kind: "history" });
    assert.equal(c.missingCurrent, true);
    assert.deepEqual(c.primary, []);
    assert.deepEqual(c.earlier.map((r) => r.version), ["1.10.0", "1.9.10", "1.9.2"]);
    const none = cardContent(null, "1.11.0", { kind: "since", since: "1.10.0" });
    assert.deepEqual(none.primary, []);
    assert.equal(none.missingCurrent, true);
    // A dev build browsing history: everything, nothing "missing".
    const dev = cardContent(index, "0.0.0-dev", { kind: "history" });
    assert.deepEqual(dev.primary.map((r) => r.version), ["1.10.0"]);
    assert.equal(dev.missingCurrent, false);
  });
});

describe("sanitizeNotes", () => {
  test("keeps allowlisted structure and local media", () => {
    const nodes = [
      { t: "h2", c: ["Hi"] },
      { t: "p", c: ["a ", { t: "a", a: { href: "https://x.example/" }, c: ["link"] }] },
      { t: "img", a: { src: "media/0123456789abcdef0123.png", alt: "Pic", width: 640 } },
      { t: "video", a: { src: "media/aa.mp4", controls: true, muted: true } },
    ];
    assert.deepEqual(sanitizeNotes(nodes), nodes);
  });

  test("drops what could run or fetch remotely", () => {
    const out = sanitizeNotes([
      { t: "script", c: ["alert(1)"] },
      { t: "p", a: { onclick: "x()", style: "color:red", class: "c" }, c: ["text"] },
      { t: "a", a: { href: "javascript:alert(1)" }, c: ["js"] },
      { t: "a", a: { href: " data:text/html,<b>" }, c: ["data"] },
      { t: "img", a: { src: "https://evil.example/track.png" } },
      { t: "img", a: { src: "../../secret.png" } },
      { t: "img", a: { src: "media/x.svg" } },
      { t: "video", a: { src: "media/v.mp4", poster: "https://evil.example/p.jpg", autoplay: true } },
      { t: "iframe", a: { src: "https://evil.example" }, c: ["inner"] },
      { t: "span", c: ["unwrapped"] },
      { t: "IMG", a: { src: "media/ok.png", onerror: "x()" } },
      { t: "ol", a: { start: "5" }, c: [{ t: "li", c: ["x"] }] },
      { t: "details", a: { open: "yes" }, c: ["d"] },
      42,
      null,
    ]);
    assert.deepEqual(out, [
      { t: "p", c: ["text"] },
      "js",
      "data",
      { t: "video", a: { src: "media/v.mp4" } },
      "unwrapped",
      { t: "img", a: { src: "media/ok.png" } },
      { t: "ol", c: [{ t: "li", c: ["x"] }] },
      { t: "details", c: ["d"] },
    ]);
  });

  test("bounded depth", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { t: "p", c: [deep] };
    const out = JSON.stringify(sanitizeNotes([deep]));
    assert.ok(!out.includes('"x"'));
  });
});
