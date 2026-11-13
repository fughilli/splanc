/**
 * A capture survives the device dropping out (PR-31, FUG-69).
 *
 * On a long capture the player's TLS heap can run out and its socket dies; the
 * capture screen used to abort the final solve with "Reconstruction failed:
 * socket closed" and throw the whole walk away, although every detection was
 * already retained on the phone. These tests mount the real capture screen
 * (ui/screens/capture.ts) and drive a capture whose device link dies partway:
 *
 *   - host-solve placement: stop_mapping fails ("socket closed"), so the screen
 *     falls back to the in-browser solver over the LOCALLY retained detections
 *     and still saves the map to the library;
 *   - phone-solve placement: the best-effort stop and the push of the solved
 *     map back to the device both fail, and the map is saved anyway (the toast
 *     says it was not pushed).
 *
 * Only the hardware seams are scripted: the camera source, the GPU detector and
 * the hue-code decoder (swapped on their module exports), the wasm solver worker
 * (a stub `Worker` that solves one LED per decoded id), the device client
 * (`appState.client`) and the library write (`mapStore.create`). Placement,
 * fallback, recentering, saving, toasting and navigation run for real. Timers
 * are mocked, so nothing waits on the wall clock.
 *
 * Every test carries exactly one requirement: PR-31.
 */

import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { DetectionRecord } from "@ledmapper/protocol";
import type { Router } from "../src/ui/app/router";
import type { CreateInput } from "../src/store/mapStore";
import {
  CODE_PARAMS,
  installCaptureSeams,
  LEDS,
  ScriptedCamera,
  ScriptedDecoder,
  SolverWorkerStub,
  turn,
  until,
} from "./captureFakes";
import { asFake, type FakeDomHandle, fire, installFakeDom, textOf } from "./fakeDom";

/** The player link (appState.client) as the capture screen uses it. `up`
 * flips false when the device drops: from then on nothing reaches it and every
 * request fails the way a closed socket fails. */
class DroppingDevice {
  up = true;
  /** A wedged player: the socket stays open but stop_mapping is never answered
   * (its receive path stalled). Everything else still works. */
  silentStop = false;
  readonly isConnected = true;
  readonly welcome = { codeParams: CODE_PARAMS };
  readonly pendingBatchCount = 0;
  readonly clock = { toServerTime: (t: number): number => t };
  received: DetectionRecord[] = [];
  calls: string[] = [];
  constructor(readonly hostSolverBenchMs: number | null) {}
  async syncClock(): Promise<void> {}
  async startMapping(ledCount: number): Promise<unknown> {
    return { type: "mapping_started", patternClockEpoch: 1000, codeParams: { ...CODE_PARAMS, ledCount } };
  }
  sendDetections(batch: DetectionRecord[]): void {
    if (this.up) this.received.push(...batch);
  }
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
  private gone(call: string): Promise<never> {
    this.calls.push(call);
    return this.up ? Promise.reject(new Error(`unexpected ${call}`)) : Promise.reject(new Error("socket closed"));
  }
  stopMapping(): Promise<never> {
    return this.gone("stopMapping");
  }
  stopMappingNoSolve(): Promise<never> {
    if (this.silentStop) {
      this.calls.push("stopMappingNoSolve");
      return new Promise(() => undefined);
    }
    return this.gone("stopMappingNoSolve");
  }
  submitMap(): Promise<unknown> {
    if (this.silentStop) {
      this.calls.push("submitMap");
      return Promise.resolve({ type: "result_ready", mapId: "pushed" });
    }
    return this.gone("submitMap");
  }
}

// -- harness ------------------------------------------------------------------

let dom: FakeDomHandle;
let CaptureScreen: typeof import("../src/ui/screens/capture").CaptureScreen;
let appState: typeof import("../src/ui/app/state").appState;
let mapStore: typeof import("../src/store/mapStore").mapStore;

before(async () => {
  dom = installFakeDom();
  await installCaptureSeams();
  ({ CaptureScreen } = await import("../src/ui/screens/capture"));
  ({ appState } = await import("../src/ui/app/state"));
  ({ mapStore } = await import("../src/store/mapStore"));
});

after(() => {
  dom.uninstall();
});

interface Run {
  device: DroppingDevice;
  saved: CreateInput[];
  navigations: string[];
  toasts: string[];
  decodedWhileUp: number;
}

/** Mount the capture screen, walk a capture whose device drops halfway
 * (`frames` camera frames before the drop and as many after), press Stop &
 * finish, and wait for the screen to navigate away. */
/** Yield until the capture's decode queue is idle (the decoded count stops
 * changing). */
async function settleDecode(): Promise<void> {
  let last = -1;
  for (let stable = 0; stable < 3; ) {
    await turn();
    const n = ScriptedDecoder.decoded.length;
    stable = n === last ? stable + 1 : 0;
    last = n;
  }
}

async function captureWithDeviceDrop(opts: {
  phoneBenchMs: number;
  hostBenchMs: number | null;
  frames?: number;
  /** Keep the device up but never answer stop_mapping (instead of dropping it). */
  silentStop?: boolean;
}): Promise<Run> {
  const frames = opts.frames ?? 24;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  mock.method(console, "info", () => undefined);
  mock.method(console, "warn", () => undefined);
  ScriptedCamera.current = null;
  ScriptedDecoder.decoded = [];
  SolverWorkerStub.problems = [];
  SolverWorkerStub.benchMs = opts.phoneBenchMs;
  const device = new DroppingDevice(opts.hostBenchMs);
  device.silentStop = opts.silentStop ?? false;
  appState.client = device as unknown as typeof appState.client;
  const saved: CreateInput[] = [];
  const store = mapStore as unknown as Record<string, unknown>;
  store["create"] = async (input: CreateInput): Promise<string> => {
    saved.push(input);
    return "lib-1";
  };
  const navigations: string[] = [];
  const router = {
    navigate: (path: string) => navigations.push(path),
    leave: (path: string) => navigations.push(path),
    origin: () => null,
  } as unknown as Router;
  const toastsBefore = document.querySelectorAll(".k-toast").length;
  try {
    const screen = CaptureScreen(router, new URLSearchParams(`leds=${LEDS}`));
    screen.onMount?.();

    // Pre-capture light probe: ~1.2 s of frames, then the pattern starts.
    await until("the light probe", () => ScriptedCamera.current?.registrations === 1);
    const cam = ScriptedCamera.current!;
    cam.emit(0);
    cam.emit(1300);
    await until("the capture loop", () => cam.registrations === 2);

    for (let i = 0; i < frames; i++) cam.emit(2000 + i * 33); // device still up
    // Decode runs in queued tasks after each frame (ui/taskPriority): on a phone
    // it keeps up within a frame or two; this burst needs the queue drained.
    await settleDecode();
    const decodedWhileUp = ScriptedDecoder.decoded.length;
    if (!device.silentStop) device.up = false; // TLS heap exhausted: the player's socket dies mid-walk
    for (let i = 0; i < frames; i++) cam.emit(2000 + (frames + i) * 33);

    fire(asFake(screen.el.querySelector(".capture-stop")), "click");
    await until("the screen to leave", () => navigations.length > 0);
    const toasts = [...document.querySelectorAll(".k-toast")].slice(toastsBefore).map((t) => textOf(t));
    screen.onUnmount?.();
    return { device, saved, navigations, toasts, decodedWhileUp };
  } finally {
    delete store["create"];
    appState.client = null;
    mock.restoreAll();
    mock.timers.reset();
  }
}

test("the device dropping before the host solve falls back to the phone solver and saves the capture [rr:PR-31]", async () => {
  // Host placement: the phone's wasm solver is much slower than the host's.
  const run = await captureWithDeviceDrop({ phoneBenchMs: 4000, hostBenchMs: 100 });

  assert.deepEqual(run.device.calls, ["stopMapping", "submitMap"], "host solve tried, then a best-effort push");
  assert.ok(run.device.received.length < ScriptedDecoder.decoded.length, "half the walk never reached the device");

  // The phone solved the WHOLE capture from what it retained locally.
  assert.equal(SolverWorkerStub.problems.length, 1);
  const problem = SolverWorkerStub.problems[0]!;
  assert.deepEqual(problem.detections, ScriptedDecoder.decoded);
  assert.equal(problem.ledCount, LEDS);

  assert.equal(run.saved.length, 1, "saved to the library");
  assert.equal(run.saved[0]!.source, "capture");
  assert.equal(run.saved[0]!.map.leds.length, LEDS);
  assert.deepEqual(run.navigations, ["/map/lib-1"]);
  assert.ok(
    run.toasts.some((t) => t.includes(`Saved ${LEDS} LEDs`) && t.includes("not pushed")),
    run.toasts.join(" | "),
  );
  assert.ok(!run.toasts.some((t) => t.startsWith("Reconstruction failed")));
});

test("on the phone-solve path a device gone for stop and push still gets the map saved [rr:PR-31]", async () => {
  // Phone placement: the wasm solver is fast enough to keep the solve local.
  const run = await captureWithDeviceDrop({ phoneBenchMs: 50, hostBenchMs: 100 });

  assert.deepEqual(run.device.calls, ["stopMappingNoSolve", "submitMap"], "device bookkeeping only, best effort");
  assert.ok(run.decodedWhileUp > 0 && run.device.received.length === run.decodedWhileUp);

  assert.equal(SolverWorkerStub.problems.length, 1);
  assert.deepEqual(SolverWorkerStub.problems[0]!.detections, ScriptedDecoder.decoded);

  assert.equal(run.saved.length, 1);
  assert.equal(run.saved[0]!.map.leds.length, LEDS);
  assert.deepEqual(run.navigations, ["/map/lib-1"]);
  assert.ok(run.toasts.some((t) => t.includes("device offline, not pushed")), run.toasts.join(" | "));
});

test("a long walk is retained whole: every one of thousands of detections reaches the solve [rr:PR-31]", async () => {
  // ~5 minutes of camera frames at 30 fps, the device gone for the second half.
  // The capture has no cap and no app-side pruning: nothing decoded is dropped.
  const run = await captureWithDeviceDrop({ phoneBenchMs: 50, hostBenchMs: null, frames: 4500 });

  assert.equal(ScriptedDecoder.decoded.length, 9000);
  assert.equal(run.device.received.length, 0, "a player without a host solver receives no observations");
  assert.equal(SolverWorkerStub.problems.length, 1);
  const solved = SolverWorkerStub.problems[0]!.detections;
  assert.equal(solved.length, 9000);
  assert.deepEqual(solved, ScriptedDecoder.decoded);
  assert.equal(run.saved.length, 1);
  assert.deepEqual(run.navigations, ["/map/lib-1"]);
});

test("a player that never acknowledges stop does not hold the phone solve hostage [rr:PR-31]", async () => {
  // Regression: "Stop & finish" awaited the device's mapping_stopped reply BEFORE
  // starting the phone solve, with no bound. A player whose receive path stalled
  // (socket still open) never answers, so the solve only ran once the socket
  // finally died. The phone already holds every detection: it must solve now.
  const run = await captureWithDeviceDrop({ phoneBenchMs: 50, hostBenchMs: null, silentStop: true });

  assert.equal(run.device.calls[0], "stopMappingNoSolve", "the stop is still sent, first");
  assert.equal(SolverWorkerStub.problems.length, 1, "the phone solved without the stop ack");
  assert.deepEqual(SolverWorkerStub.problems[0]!.detections, ScriptedDecoder.decoded);
  assert.equal(run.saved.length, 1);
  assert.deepEqual(run.navigations, ["/map/lib-1"]);
});
