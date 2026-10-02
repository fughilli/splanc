/**
 * Rendering budget of the Effects tab's animated 64×64 preview tiles (FUG-80;
 * src/ui/screens/effectPreviewTiles.ts + src/fx/livePreview.ts). Every tile runs
 * the real firmware VM, so the tiles must never all render at once, animate
 * off-screen, or outlive the list they belong to. The bounds pinned here drive
 * the REAL tile pipeline — previewCache → compile → VM → webm encode → live
 * canvas fallback — on the fake DOM, with the compiler / VM wasm packages faked
 * (moduleStubs.ts) and visibility driven through the fake IntersectionObserver:
 *
 *   - lazy: nothing renders until a tile scrolls into view (150 px early);
 *   - bounded: at most 3 renders in flight; the rest queue, and a failing effect
 *     frees its slot without spinning up a VM;
 *   - live tiles animate only while visible; a list rebuild (`reset`) frees every
 *     VM, revokes every clip URL, drops queued renders, and stops observing;
 *   - a cached clip is replayed without compiling or running the VM;
 *   - a live tile redraws at most 30×/s on any display and caps its catch-up
 *     after a stall (no burst of hundreds of VM frames).
 */

import { stubModule } from "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installFakeDom, asFake, type FakeDomHandle, type FakeElement } from "./fakeDom";

const dom: FakeDomHandle = installFakeDom();

// <video> elements need play()/pause() (browser media API) on the fake DOM.
{
  const doc = document as unknown as Record<string, unknown>;
  const create = document.createElement;
  doc["createElement"] = function (this: Document, tag: string) {
    const el = create.call(document, tag);
    if (tag === "video") {
      const v = asFake(el);
      v["play"] = async () => void (v["plays"] = Number(v["plays"] ?? 0) + 1);
      v["pause"] = () => void (v["pauses"] = Number(v["pauses"] ?? 0) + 1);
    }
    return el;
  };
}

// -- fake wasm packages (fx_compiler + fx_vm) ----------------------------------------

const vm = { created: 0, freed: 0, instances: [] as FakeVm[] };
const compiled: string[] = [];
stubModule(/\/fx_compiler_wasm_pkg\.js$/, {
  __esModule: true,
  default: async () => undefined,
  fx_compile: (src: string) => {
    compiled.push(src);
    const ok = !src.includes("BROKEN");
    return { ok, bytecode: new Uint8Array([1, 2, 3]), manifest: "[]", diagnostics: ok ? "[]" : '[{"line":0,"col":0,"msg":"x"}]' };
  },
});
class FakeVm {
  ticks = 0;
  constructor() {
    vm.created++;
    vm.instances.push(this);
  }
  set_uniform(): void {}
  set_topology(): void {}
  set_graph(): void {}
  set_texture(): void {}
  update(): void {
    this.ticks++;
  }
  shade_all(positions: Float32Array): Uint8Array {
    return new Uint8Array(positions.length).fill(9);
  }
  free(): void {
    vm.freed++;
  }
}
stubModule(/\/fx_vm_wasm_pkg\.js$/, { __esModule: true, default: async () => undefined, FxPreview: FakeVm });

import { EffectPreviewTiles } from "../src/ui/screens/effectPreviewTiles";
import { LiveEffectPreview } from "../src/fx/livePreview";
import { previewCache } from "../src/store/previewCache";

const SRC = (n: number): string => `// effect ${n}\nvec3 shade(Led l) { return vec3(l.uv, 0.5); }`;

// -- previewCache seam: lookups the test can hold open -----------------------------

const realGet = previewCache.get.bind(previewCache);
let lookups: { id: string; source: string; resolve: (b: Blob | null) => void }[] = [];
let holdLookups = false;
let cachedClips = new Map<string, Blob>();

const realRevoke = URL.revokeObjectURL;
let revoked: string[] = [];

let controllers: EffectPreviewTiles[] = [];
function tilesController(): EffectPreviewTiles {
  const t = new EffectPreviewTiles();
  controllers.push(t);
  return t;
}

beforeEach(() => {
  vm.created = vm.freed = 0;
  vm.instances = [];
  compiled.length = 0;
  lookups = [];
  holdLookups = false;
  cachedClips = new Map();
  previewCache.get = (id: string, source: string) =>
    new Promise<Blob | null>((resolve) => {
      lookups.push({ id, source, resolve });
      if (!holdLookups) resolve(cachedClips.get(id) ?? null);
    });
  revoked = [];
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u);
    realRevoke(u);
  };
});
afterEach(() => {
  for (const t of controllers) t.dispose();
  controllers = [];
  previewCache.get = realGet;
  URL.revokeObjectURL = realRevoke;
  document.body.replaceChildren();
  dom.flushAnimationFrames();
});

/** Let the async render chain (lookup → compile → VM → encode → live) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}

/** An effects list: n thumbnail cells registered with the tiles controller. */
function list(tiles: EffectPreviewTiles, n: number, src: (i: number) => string = SRC): FakeElement[] {
  const thumbs: FakeElement[] = [];
  for (let i = 0; i < n; i++) {
    const thumb = asFake(document.createElement("div"));
    thumb.className = "map-thumb";
    thumb.textContent = "✨";
    document.body.appendChild(thumb as unknown as Node);
    tiles.observe(thumb as unknown as HTMLElement, `fx-${i}`, src(i));
    thumbs.push(thumb);
  }
  return thumbs;
}
const shows = (el: FakeElement): string => el.firstElementChild?.localName ?? "placeholder";

test("effect preview tiles render lazily: nothing renders until a tile scrolls into view [rr:PR-33]", async () => {
  const tiles = tilesController();
  const thumbs = list(tiles, 8);
  await settle();
  assert.equal(lookups.length, 0, "no cache lookup before anything is visible");
  assert.equal(compiled.length, 0, "no compile");
  assert.equal(vm.created, 0, "no VM");
  // Tiles start rendering slightly before they scroll in.
  assert.deepEqual(dom.observers[0]!.options, { rootMargin: "150px" });

  dom.intersect(thumbs[5]!, true);
  await settle();
  assert.deepEqual(lookups.map((l) => l.id), ["fx-5"]);
  assert.equal(shows(thumbs[5]!), "canvas", "the visible tile animates");
  assert.deepEqual(thumbs.filter((t) => shows(t) !== "placeholder").length, 1, "only the visible tile rendered");
  // Scrolling it back into view later doesn't render it again.
  dom.intersect(thumbs[5]!, false);
  dom.intersect(thumbs[5]!, true);
  await settle();
  assert.equal(lookups.length, 1);
  tiles.dispose();
});

test("at most three previews render at once; the rest queue and a broken effect frees its slot [rr:PR-33]", async () => {
  holdLookups = true;
  const tiles = tilesController();
  const thumbs = list(tiles, 7, (i) => (i === 1 ? "BROKEN" : SRC(i)));
  for (const t of thumbs) dom.intersect(t, true); // the whole list scrolls into view
  await settle();
  assert.deepEqual(lookups.map((l) => l.id), ["fx-0", "fx-1", "fx-2"], "three in flight, four queued");

  let maxInFlight = 0;
  while (lookups.some((l) => l.resolve !== noop)) {
    const open = lookups.filter((l) => l.resolve !== noop);
    maxInFlight = Math.max(maxInFlight, open.length);
    const next = open[0]!;
    next.resolve(null);
    next.resolve = noop;
    await settle();
  }
  assert.equal(maxInFlight, 3);
  assert.equal(lookups.length, 7, "every visible tile eventually rendered");
  assert.equal(shows(thumbs[1]!), "placeholder", "the broken effect keeps its placeholder");
  assert.deepEqual(
    thumbs.map(shows),
    ["canvas", "placeholder", "canvas", "canvas", "canvas", "canvas", "canvas"],
  );
  // Only the 6 working effects hold a live VM (each render's encode VM was freed).
  assert.equal(vm.created - vm.freed, 6);
  tiles.dispose();
});
const noop = (): void => undefined;

test("live preview tiles animate only while on screen [rr:PR-33]", async () => {
  const tiles = tilesController();
  const [a] = list(tiles, 1);
  const idle = dom.pendingAnimationFrames;
  dom.intersect(a!, true);
  await settle();
  assert.equal(shows(a!), "canvas");
  const tile = vm.instances.at(-1)!; // the live tile's VM
  assert.equal(dom.pendingAnimationFrames, idle + 1, "animating");
  dom.flushAnimationFrames(1000);
  dom.flushAnimationFrames(1100);
  const ticking = tile.ticks;
  assert.ok(ticking > 0);

  // Scrolled out of view: the VM stops ticking entirely.
  dom.intersect(a!, false);
  assert.equal(dom.pendingAnimationFrames, idle);
  dom.flushAnimationFrames(1200);
  assert.equal(tile.ticks, ticking);

  // Back in view: it resumes.
  dom.intersect(a!, true);
  assert.equal(dom.pendingAnimationFrames, idle + 1);
  dom.flushAnimationFrames(1300);
  dom.flushAnimationFrames(1400);
  assert.ok(tile.ticks > ticking);
  tiles.dispose();
});

test("a cached clip is replayed without compiling or running the VM [rr:PR-33]", async () => {
  cachedClips.set("fx-0", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "video/webm" }));
  const tiles = tilesController();
  const [a] = list(tiles, 1);
  dom.intersect(a!, true);
  await settle();
  assert.deepEqual(lookups.map((l) => [l.id, l.source]), [["fx-0", SRC(0)]]);
  const video = a!.firstElementChild!;
  assert.equal(video.localName, "video");
  assert.match(String(video.src), /^blob:/);
  assert.equal(video["loop"], true);
  assert.equal(video["muted"], true);
  assert.equal(compiled.length, 0, "no compile");
  assert.equal(vm.created, 0, "no VM");
  // Off screen, the clip pauses too.
  dom.intersect(a!, false);
  assert.equal(video["pauses"], 1);
  tiles.dispose();
});

test("rebuilding the list frees every preview VM and clip URL and drops queued renders [rr:PR-33]", async () => {
  holdLookups = true;
  cachedClips.set("fx-0", new Blob([new Uint8Array([1])], { type: "video/webm" }));
  const tiles = tilesController();
  const thumbs = list(tiles, 6);
  for (const t of thumbs) dom.intersect(t, true);
  await settle();
  // Finish the first three (one cached clip, two live), leave three queued.
  for (const l of lookups.slice(0, 3)) l.resolve(cachedClips.get(l.id) ?? null);
  await settle();
  // …which starts the next three; hold those open.
  assert.equal(lookups.length, 6);
  const clipUrl = String(thumbs[0]!.firstElementChild!.src);
  const liveVms = vm.created - vm.freed;
  assert.equal(liveVms, 2);

  tiles.reset();
  assert.equal(vm.created - vm.freed, 0, "every live VM freed");
  assert.deepEqual(revoked, [clipUrl], "every clip URL revoked");
  assert.equal(dom.observers[0]!.disconnected, true, "no longer observing the old rows");
  assert.equal(dom.pendingAnimationFrames, 0, "nothing animating");
  // Renders that were in flight for the old list don't land (no clip, no VM).
  const [late, ...rest] = lookups.slice(3);
  late!.resolve(new Blob([new Uint8Array([2])], { type: "video/webm" }));
  for (const l of rest) l.resolve(null);
  await settle();
  assert.equal(vm.created - vm.freed, 0);
  assert.deepEqual(thumbs.slice(3).map(shows), ["placeholder", "placeholder", "placeholder"]);
});

test("a live preview redraws at most 30 times a second and caps its catch-up after a stall [rr:PR-33]", async () => {
  const canvas = document.createElement("canvas");
  const live = (await LiveEffectPreview.create(canvas, SRC(0)))!;
  assert.ok(live);
  const own = vm.instances.at(-1)!;
  const ctx = asFake(canvas).getContext("2d")!;
  const draws = (): number => ctx.calls.filter((c) => c === "putImageData").length;

  const idle = dom.pendingAnimationFrames;
  live.play();
  let t = 10_000;
  dom.flushAnimationFrames(t); // first frame paints immediately
  // One second on a 250 Hz display: still no more than ~30 redraws.
  for (let i = 0; i < 250; i++) dom.flushAnimationFrames((t += 4));
  assert.ok(draws() <= 31, `${draws()} redraws in 1 s`);
  assert.ok(draws() >= 20, `only ${draws()} redraws in 1 s`);

  // A 5 s stall (backgrounded tab): one redraw advancing at most 4 VM frames,
  // not a 300-frame catch-up burst.
  const ticks = own.ticks;
  const before = draws();
  dom.flushAnimationFrames((t += 5000));
  assert.equal(draws(), before + 1);
  assert.equal(own.ticks - ticks, 4);

  // Paused: the frame loop stops; disposed: the VM is freed.
  live.pause();
  assert.equal(dom.pendingAnimationFrames, idle);
  dom.flushAnimationFrames((t += 100));
  assert.equal(draws(), before + 1);
  const freed = vm.freed;
  live.dispose();
  assert.equal(vm.freed, freed + 1);
});
