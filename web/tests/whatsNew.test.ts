/**
 * "What's new?" (release notes card): version order, when the sparkle bubble
 * shows (fresh install, update, skipped versions, after it was seen, a PWA
 * pull-to-refresh into a new deploy, play-mode launches), the product list,
 * each product's newest-first history and its "Jump to…" targets, and the
 * allowlist the mirrored notes pass before reaching the DOM.
 *
 * testdata/whatsnew-{index,app,firmware,bridge}.json are what
 * tools/whatsnew/whatsnew_mirror.py emits for its own fixture releases
 * (tools/whatsnew/testdata/releases.json).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APP_PRODUCT,
  compareVersions,
  deserializeWhatsNewState,
  jumpTargets,
  parseIndex,
  parseProductNotes,
  parseReleaseVersion,
  pickProduct,
  planBoot,
  productHistory,
  releaseAnchor,
  sanitizeNotes,
  serializeWhatsNewState,
  type ReleaseNotes,
  type WhatsNewState,
} from "../src/ui/whatsnew/model";
import appJson from "./testdata/whatsnew-app.json";
import bridgeJson from "./testdata/whatsnew-bridge.json";
import firmwareJson from "./testdata/whatsnew-firmware.json";
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

describe("index + products", () => {
  const index = parseIndex(indexJson)!;

  test("the mirror's fixture index lists the products in order", () => {
    assert.ok(index);
    assert.equal(index.schema, 2);
    assert.deepEqual(
      index.products.map((p) => [p.id, p.name, p.label, p.file, p.count, p.latest]),
      [
        ["app", "Splanc app", "Splanc", "app.json", 3, "1.10.0"],
        ["firmware", "Firmware", "Firmware", "firmware.json", 2, "1.9.0"],
        ["bridge", "Bridge", "Bridge", "bridge.json", 1, "1.0.0"],
      ],
    );
  });

  test("product files parse newest first, whatever order they arrive in", () => {
    const app = parseProductNotes(appJson, "app")!;
    assert.deepEqual(app.map((r) => r.version), ["1.10.0", "1.9.10", "1.9.2"]);
    assert.equal(app[0]!.name, "Splanc 1.10.0");
    assert.equal(app[0]!.media.length, 3);
    const shuffled = { ...firmwareJson, releases: [...firmwareJson.releases].reverse() };
    assert.deepEqual(parseProductNotes(shuffled, "firmware")!.map((r) => r.version), ["1.9.0", "1.8.0"]);
    assert.deepEqual(parseProductNotes(bridgeJson, "bridge")!.map((r) => r.tag), ["pi-bridge-v1.0.0"]);
  });

  test("a product file must be that product's, at a known schema", () => {
    assert.equal(parseProductNotes(appJson, "firmware"), null);
    assert.equal(parseProductNotes({ ...appJson, schema: 3 }, "app"), null);
    assert.equal(parseProductNotes(null, "app"), null);
  });

  test("rejects a missing or unknown index; drops bad product entries", () => {
    assert.equal(parseIndex(null), null);
    assert.equal(parseIndex({ schema: 3, products: [] }), null);
    assert.equal(parseIndex({ schema: 2 }), null);
    assert.equal(parseIndex("nope"), null);
    const odd = parseIndex({
      schema: 2,
      products: [
        { id: "app", file: "app.json", count: 2, name: "Splanc app" },
        { id: "../x", file: "x.json", count: 1 },
        { id: "fw", file: "https://evil.example/fw.json", count: 1 },
        { id: "fw2", file: "../fw.json", count: 1 },
        { id: "empty", file: "empty.json", count: 0 },
        { id: "app", file: "dupe.json", count: 1 },
        null,
      ],
    })!;
    assert.deepEqual(odd.products.map((p) => [p.id, p.label, p.latest]), [["app", "Splanc app", null]]);
  });

  test("a schema-1 index (inline app + firmware notes) still reads", () => {
    const v1 = parseIndex({
      schema: 1,
      releases: appJson.releases,
      firmware: firmwareJson.releases.slice(0, 1),
    })!;
    assert.deepEqual(v1.products.map((p) => [p.id, p.file, p.count]), [
      ["app", null, 3],
      ["firmware", null, 1],
    ]);
    assert.deepEqual(v1.products[0]!.releases!.map((r) => r.version), ["1.10.0", "1.9.10", "1.9.2"]);
    assert.equal(parseIndex({ schema: 1 })!.products.length, 0);
  });

  test("pickProduct: the wanted one, else the app, else the first", () => {
    assert.equal(pickProduct(index, "bridge")!.id, "bridge");
    assert.equal(pickProduct(index, null)!.id, APP_PRODUCT);
    assert.equal(pickProduct(index, "gone")!.id, APP_PRODUCT);
    const noApp = { ...index, products: index.products.filter((p) => p.id !== "app") };
    assert.equal(pickProduct(noApp, "gone")!.id, "firmware");
    assert.equal(pickProduct(null, "app"), null);
    assert.equal(pickProduct({ ...index, products: [] }, "app"), null);
  });
});

describe("productHistory + jumpTargets", () => {
  const app = parseProductNotes(appJson, "app")!;
  const fw = parseProductNotes(firmwareJson, "firmware")!;
  const versions = (rs: ReleaseNotes[]): string[] => rs.map((r) => r.version);

  test("the whole history, newest first, nothing marked from About", () => {
    const h = productHistory("app", [...app].reverse(), "1.10.0", { kind: "history" });
    assert.deepEqual(versions(h.releases), ["1.10.0", "1.9.10", "1.9.2"]);
    assert.equal(h.fresh.size, 0);
    assert.equal(h.missingCurrent, false);
  });

  test("from the sparkle: every skipped version is marked new", () => {
    const h = productHistory("app", app, "1.10.0", { kind: "since", since: "1.9.2" });
    assert.deepEqual(versions(h.releases), ["1.10.0", "1.9.10", "1.9.2"]); // still the whole list
    assert.deepEqual([...h.fresh], ["1.10.0", "1.9.10"]);
    // Last-seen version unknown (an update from a pre-feature build): the current one.
    assert.deepEqual([...productHistory("app", app, "1.9.10", { kind: "since", since: null }).fresh], ["1.9.10"]);
  });

  test("never lists app releases newer than the running build", () => {
    const h = productHistory("app", app, "1.9.10", { kind: "since", since: "1.9.2" });
    assert.deepEqual(versions(h.releases), ["1.9.10", "1.9.2"]);
    assert.deepEqual([...h.fresh], ["1.9.10"]);
  });

  test("running version not mirrored yet; dev builds see everything", () => {
    const h = productHistory("app", app, "1.11.0", { kind: "history" });
    assert.equal(h.missingCurrent, true);
    assert.deepEqual(versions(h.releases), ["1.10.0", "1.9.10", "1.9.2"]);
    const dev = productHistory("app", app, "0.0.0-dev", { kind: "since", since: "1.9.2" });
    assert.deepEqual(versions(dev.releases), ["1.10.0", "1.9.10", "1.9.2"]);
    assert.equal(dev.missingCurrent, false);
    assert.equal(dev.fresh.size, 0);
  });

  test("other products: everything, unaffected by the app version", () => {
    const h = productHistory("firmware", fw, "1.0.0", { kind: "since", since: "0.9.0" });
    assert.deepEqual(versions(h.releases), ["1.9.0", "1.8.0"]);
    assert.equal(h.fresh.size, 0);
    assert.equal(h.missingCurrent, false);
  });

  test("Jump to…: the product's versions, latest on top, anchored per product", () => {
    const h = productHistory("app", app, "1.10.0", { kind: "since", since: "1.9.10" });
    assert.deepEqual(jumpTargets("app", h), [
      { version: "1.10.0", label: "1.10.0 (new)", anchor: "wn-app-1-10-0" },
      { version: "1.9.10", label: "1.9.10", anchor: "wn-app-1-9-10" },
      { version: "1.9.2", label: "1.9.2 (pre-release)", anchor: "wn-app-1-9-2" },
    ]);
    const f = jumpTargets("firmware", productHistory("firmware", fw, undefined, { kind: "history" }));
    assert.deepEqual(f.map((t) => t.anchor), ["wn-firmware-1-9-0", "wn-firmware-1-8-0"]);
    assert.notEqual(releaseAnchor("app", "1.9.0"), releaseAnchor("firmware", "1.9.0"));
    assert.equal(jumpTargets("bridge", productHistory("bridge", [], undefined, { kind: "history" })).length, 0);
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
