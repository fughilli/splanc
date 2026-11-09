/**
 * #442: after Stop & finish, Back from the mapping result re-entered the
 * mapping workspace — a fresh capture screen mounted and started a new mapping
 * session on the device, disrupting the connection.
 *
 * The Router tests drive the real hash router (ui/app/router.ts) over a small
 * fake of the browser's session history (location.hash / location.replace /
 * history.back/forward/state, with async hashchange). The capture tests mount
 * the real capture screen through that router (scripted camera / detector /
 * decoder / solver seams from captureFakes.ts) and walk the demo sequence:
 * Maps → capture → Stop & finish → result → Back (app button and browser),
 * Forward, then assert the capture never restarts and the device link is left
 * usable (no extra start_mapping, no stray stop).
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { DetectionRecord } from "@ledmapper/protocol";
import type { CreateInput } from "../src/store/mapStore";
import type { Router as RouterT, Screen } from "../src/ui/app/router";
import { CODE_PARAMS, installCaptureSeams, LEDS, ScriptedCamera, ScriptedDecoder, SolverWorkerStub, until } from "./captureFakes";
import { asFake, type FakeDomHandle, fire, installFakeDom } from "./fakeDom";

// -- fake session history -------------------------------------------------------

interface Entry {
  hash: string;
  state: unknown;
}

/** Session history the way the router uses it: assigning location.hash pushes
 * (dropping forward entries), location.replace swaps the current entry, and
 * back/forward traverse; every hash change fires `hashchange` on a later
 * macrotask, like a browser. */
class FakeHistory {
  entries: Entry[];
  index = 0;
  constructor(
    private readonly win: { dispatchEvent(e: Event): boolean },
    initial: string,
  ) {
    this.entries = [{ hash: initial, state: null }];
  }
  get current(): Entry {
    return this.entries[this.index]!;
  }
  private fire(): void {
    setImmediate(() => this.win.dispatchEvent(new Event("hashchange")));
  }
  readonly location = ((h: FakeHistory) => ({
    get hash(): string {
      return h.current.hash;
    },
    set hash(v: string) {
      const next = v.startsWith("#") ? v : `#${v}`;
      if (next === h.current.hash) return;
      h.entries.splice(h.index + 1);
      h.entries.push({ hash: next, state: null });
      h.index++;
      h.fire();
    },
    replace(url: string): void {
      const next = url.slice(url.indexOf("#"));
      const changed = next !== h.current.hash;
      h.entries[h.index] = { hash: next, state: null };
      if (changed) h.fire();
    },
    href: "https://app.test/",
    host: "app.test",
    protocol: "https:",
    search: "",
  }))(this);
  readonly history = ((h: FakeHistory) => ({
    get state(): unknown {
      return h.current.state;
    },
    replaceState(state: unknown): void {
      h.current.state = state;
    },
    // Traversal is asynchronous, as in a browser: location still shows the old
    // entry until a later task, and only then does hashchange fire.
    back(): void {
      setImmediate(() => h.traverse(-1));
    },
    forward(): void {
      setImmediate(() => h.traverse(1));
    },
  }))(this);
  traverse(delta: number): void {
    const to = this.index + delta;
    if (to < 0 || to >= this.entries.length) return;
    const before = this.current.hash;
    this.index = to;
    if (this.current.hash !== before) this.win.dispatchEvent(new Event("hashchange"));
  }
  hashes(): string[] {
    return this.entries.map((e) => e.hash);
  }
}

let dom: FakeDomHandle;
let Router: typeof import("../src/ui/app/router").Router;
let CaptureScreen: typeof import("../src/ui/screens/capture").CaptureScreen;
let appState: typeof import("../src/ui/app/state").appState;
let mapStore: typeof import("../src/store/mapStore").mapStore;
let nav: FakeHistory;

before(async () => {
  dom = installFakeDom();
  await installCaptureSeams();
  ({ Router } = await import("../src/ui/app/router"));
  ({ CaptureScreen } = await import("../src/ui/screens/capture"));
  ({ appState } = await import("../src/ui/app/state"));
  ({ mapStore } = await import("../src/store/mapStore"));
});

after(() => dom.uninstall());

/** Fresh session history per test. Routers have no stop(), so each test also
 * gets its own window event bus (the rest of `window` delegates to the fake
 * DOM's): an earlier test's router never hears this test's hashchanges. */
function installHistory(initial: string): FakeHistory {
  const bus = new EventTarget();
  const win = new Proxy(dom.window as unknown as object, {
    get(t, k) {
      if (k === "addEventListener" || k === "removeEventListener" || k === "dispatchEvent") {
        return (bus[k] as unknown as (...a: unknown[]) => unknown).bind(bus);
      }
      const v: unknown = Reflect.get(t, k);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const h = new FakeHistory(bus, initial);
  const g = globalThis as unknown as Record<string, unknown>;
  Object.defineProperty(g, "window", { value: win, configurable: true, writable: true });
  Object.defineProperty(g, "location", { value: h.location, configurable: true, writable: true });
  Object.defineProperty(g, "history", { value: h.history, configurable: true, writable: true });
  return h;
}

const settle = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A trivial screen that records its mounts. */
function stub(name: string, log: string[]): Screen {
  const el = document.createElement("div");
  el.className = `stub-${name}`;
  return { el, onMount: () => log.push(name) };
}

function makeRouter(log: string[], extra: (r: RouterT) => void = () => undefined): RouterT {
  const outlet = document.createElement("div");
  document.body.append(outlet);
  const r = new Router(outlet as unknown as HTMLElement);
  r.add("/maps", () => stub("maps", log));
  r.add("/map/:id", (m) => stub(`map:${m.params["id"]}`, log));
  r.add("/effects", () => stub("effects", log));
  r.add("/once", () => stub("once", log));
  extra(r);
  r.start();
  return r;
}

beforeEach(() => {
  dom.document.body.replaceChildren();
});

// -- Router ------------------------------------------------------------------------

test("leave() back to the origin pops the one-shot entry; Forward can't re-enter it", async () => {
  nav = installHistory("#/maps");
  const log: string[] = [];
  const r = makeRouter(log);
  await settle();
  r.navigate("/once");
  await settle();
  assert.equal(r.origin(), "/maps");
  r.leave("/maps");
  await settle();
  assert.equal(nav.location.hash, "#/maps");
  assert.deepEqual(log, ["maps", "once", "maps"]);
  // Forward lands on the stamped entry: redirected, never re-mounted.
  nav.history.forward();
  await settle();
  assert.equal(nav.location.hash, "#/maps");
  assert.ok(!log.slice(3).includes("once"), `re-mounted: ${log.join(",")}`);
});

test("navigating right after leave() pops back still opens the screen (cancel, then a new capture)", async () => {
  nav = installHistory("#/maps");
  const log: string[] = [];
  const r = makeRouter(log);
  await settle();
  r.navigate("/once");
  await settle();
  r.leave("/maps"); // pops back to /maps, asynchronously
  r.navigate("/once"); // before that traversal has landed
  await settle();
  assert.equal(nav.location.hash, "#/once");
  assert.deepEqual(log, ["maps", "once", "maps", "once"]);
  // The new entry is a fresh one: not stamped as left.
  assert.equal((nav.history.state as Record<string, unknown> | null)?.["splancLeftTo"], undefined);
});

test("leave() elsewhere replaces the one-shot entry, so Back skips it", async () => {
  nav = installHistory("#/maps");
  const log: string[] = [];
  const r = makeRouter(log);
  await settle();
  r.navigate("/once");
  await settle();
  r.leave("/map/new");
  await settle();
  assert.deepEqual(nav.hashes(), ["#/maps", "#/map/new"]);
  r.back();
  await settle();
  assert.equal(nav.location.hash, "#/maps");
  nav.history.forward();
  await settle();
  assert.equal(nav.location.hash, "#/map/new");
  assert.deepEqual(log, ["maps", "once", "map:new", "maps", "map:new"]);
});

test("origin() is only set by an in-app push, not by a deep link or history traversal", async () => {
  nav = installHistory("#/once");
  const log: string[] = [];
  const r = makeRouter(log);
  await settle();
  assert.equal(r.origin(), null, "deep link");
  r.navigate("/maps");
  await settle();
  assert.equal(r.origin(), "/once");
  r.back();
  await settle();
  assert.equal(r.origin(), null, "reached by Back");
});

test("a reload on an entry a one-shot screen was left from redirects instead of re-mounting", async () => {
  nav = installHistory("#/maps");
  const log: string[] = [];
  const r1 = makeRouter(log);
  await settle();
  r1.navigate("/once");
  await settle();
  // Stamp it, then simulate the user going Back onto it via a stale entry:
  r1.leave("/map/x");
  await settle();
  // A second router on the same history (a reload) at an entry stamped ended:
  nav.entries.push({ hash: "#/once", state: { splancLeftTo: "#/map/x" } });
  nav.index = nav.entries.length - 1;
  const log2: string[] = [];
  makeRouter(log2);
  await settle();
  assert.deepEqual(log2, ["map:x"]);
});

// -- the capture screen through the router ------------------------------------------

/** The player link as the capture screen uses it, always up; records calls. */
class LiveDevice {
  readonly isConnected = true;
  readonly welcome = { codeParams: CODE_PARAMS };
  readonly pendingBatchCount = 0;
  readonly clock = { toServerTime: (t: number): number => t };
  readonly hostSolverBenchMs = null;
  calls: string[] = [];
  /** Hold startMapping until released (to leave mid-startup). */
  holdStart: Promise<void> | null = null;
  async syncClock(): Promise<void> {}
  async startMapping(ledCount: number): Promise<unknown> {
    this.calls.push("startMapping");
    if (this.holdStart) await this.holdStart;
    return { type: "mapping_started", patternClockEpoch: 1000, codeParams: { ...CODE_PARAMS, ledCount } };
  }
  sendDetections(_b: DetectionRecord[]): void {}
  sendImuBatch(): void {}
  sendExposureReport(): void {}
  getStatus(): Promise<never> {
    return new Promise(() => undefined);
  }
  getLiveMap(): Promise<unknown> {
    return Promise.resolve({ type: "live_map", active: true, map: null });
  }
  getSolveStatus(): Promise<never> {
    return new Promise(() => undefined);
  }
  configure(): Promise<never> {
    return new Promise(() => undefined);
  }
  async stopMapping(): Promise<unknown> {
    this.calls.push("stopMapping");
    return {};
  }
  async stopMappingNoSolve(): Promise<unknown> {
    this.calls.push("stopMappingNoSolve");
    return {};
  }
  async submitMap(): Promise<unknown> {
    this.calls.push("submitMap");
    return { type: "result_ready", mapId: "pushed" };
  }
}

interface CaptureRig {
  r: RouterT;
  log: string[];
  device: LiveDevice;
  saved: CreateInput[];
  restore(): void;
}

function captureRig(initial = "#/maps"): CaptureRig {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  mock.method(console, "info", () => undefined);
  mock.method(console, "warn", () => undefined);
  ScriptedCamera.current = null;
  ScriptedDecoder.decoded = [];
  SolverWorkerStub.problems = [];
  SolverWorkerStub.benchMs = 50; // phone-solve placement
  nav = installHistory(initial);
  const device = new LiveDevice();
  appState.client = device as unknown as typeof appState.client;
  const saved: CreateInput[] = [];
  const store = mapStore as unknown as Record<string, unknown>;
  store["create"] = async (input: CreateInput): Promise<string> => {
    saved.push(input);
    return "lib-1";
  };
  const log: string[] = [];
  const r = makeRouter(log, (rt) =>
    rt.add("/capture", (m) => {
      log.push("capture");
      return CaptureScreen(rt, m.query);
    }),
  );
  return {
    r,
    log,
    device,
    saved,
    restore: () => {
      delete store["create"];
      appState.client = null;
      mock.restoreAll();
      mock.timers.reset();
    },
  };
}

/** Walk the capture to the point frames are flowing. */
async function scan(): Promise<ScriptedCamera> {
  await until("the light probe", () => ScriptedCamera.current?.registrations === 1);
  const cam = ScriptedCamera.current!;
  cam.emit(0);
  cam.emit(1300);
  await until("the capture loop", () => cam.registrations === 2);
  for (let i = 0; i < 16; i++) cam.emit(2000 + i * 33);
  return cam;
}

function stopButton(): ReturnType<typeof asFake> {
  const b = document.querySelector(".capture-stop");
  assert.ok(b, "stop button");
  return asFake(b);
}

test("Back (app button) from a finished capture's result goes to Maps; the capture never restarts", async () => {
  const rig = captureRig();
  try {
    await settle();
    rig.r.navigate(`/capture?leds=${LEDS}`);
    await settle();
    await scan();
    fire(stopButton(), "click");
    await until("the result", () => nav.location.hash === "#/map/lib-1");
    await settle();
    assert.equal(rig.saved.length, 1);
    assert.deepEqual(nav.hashes(), ["#/maps", "#/map/lib-1"], "the capture entry is gone from history");

    rig.r.back(); // the shell's app-bar Back
    await settle();
    assert.equal(nav.location.hash, "#/maps");
    nav.history.forward(); // browser Forward
    await settle();
    assert.equal(nav.location.hash, "#/map/lib-1");
    rig.r.back();
    await settle();
    rig.r.navigate("/effects"); // then open the effects
    await settle();

    assert.equal(rig.log.filter((s) => s === "capture").length, 1, rig.log.join(","));
    assert.equal(rig.device.calls.filter((c) => c === "startMapping").length, 1, rig.device.calls.join(","));
    // The device link was used once for the solve bookkeeping and left alone after.
    assert.deepEqual(rig.device.calls, ["startMapping", "stopMappingNoSolve", "submitMap"]);
    assert.equal(appState.client, rig.device as unknown, "same connection, still selected");
  } finally {
    rig.restore();
  }
});

test("a capture opened from the map it re-creates returns there without a duplicate entry; Forward does not restart it", async () => {
  const rig = captureRig("#/map/lib-1");
  try {
    await settle();
    rig.r.navigate(`/capture?leds=${LEDS}`);
    await settle();
    await scan();
    fire(stopButton(), "click");
    // The result is the map the capture was opened from: pop back to it.
    await until("the result", () => nav.location.hash === "#/map/lib-1" && rig.log.at(-1) === "map:lib-1");
    await settle();
    assert.equal(nav.index, 0, "no duplicate #/map/lib-1 entry");
    nav.history.forward(); // the popped capture entry is stamped: redirected
    await settle();
    assert.equal(nav.location.hash, "#/map/lib-1");
    assert.equal(rig.log.filter((x) => x === "capture").length, 1, rig.log.join(","));
    assert.equal(rig.device.calls.filter((c) => c === "startMapping").length, 1);
  } finally {
    rig.restore();
  }
});

test("Cancel returns to where the capture was opened, ends the device session, and Forward doesn't restart it", async () => {
  const rig = captureRig();
  try {
    await settle();
    rig.r.navigate(`/capture?leds=${LEDS}`);
    await settle();
    await scan();
    const cancel = document.querySelector(".capture-topbar button");
    assert.ok(cancel);
    fire(asFake(cancel), "click");
    await settle(8);
    assert.equal(nav.location.hash, "#/maps");
    assert.ok(rig.device.calls.includes("stopMappingNoSolve"));
    nav.history.forward();
    await settle();
    assert.equal(nav.location.hash, "#/maps", "the cancelled capture's entry redirects");
    assert.equal(rig.log.filter((s) => s === "capture").length, 1);
    assert.equal(rig.device.calls.filter((c) => c === "startMapping").length, 1);
  } finally {
    rig.restore();
  }
});

test("browser Back mid-capture ends the device session; a late startup never navigates or toasts", async () => {
  const rig = captureRig();
  let release: () => void = () => undefined;
  rig.device.holdStart = new Promise<void>((r) => (release = r));
  try {
    await settle();
    rig.r.navigate(`/capture?leds=${LEDS}`);
    await settle();
    await until("the probe", () => ScriptedCamera.current?.registrations === 1);
    const cam = ScriptedCamera.current!;
    cam.emit(0);
    cam.emit(1300);
    await until("start_mapping in flight", () => rig.device.calls.includes("startMapping"));
    const toastsBefore = document.querySelectorAll(".k-toast").length;
    nav.history.back(); // browser Back while the device is still answering
    await settle();
    assert.equal(nav.location.hash, "#/maps");
    release();
    await settle(10);
    assert.equal(nav.location.hash, "#/maps", "the abandoned startup did not navigate");
    assert.equal(document.querySelectorAll(".k-toast").length, toastsBefore, "no stale toast");
    assert.ok(rig.device.calls.includes("stopMappingNoSolve"), "the session it opened is closed");
    assert.equal(cam.registrations, 1, "the capture loop never started");
  } finally {
    rig.restore();
  }
});
