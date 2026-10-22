/**
 * Room localization (docs/design/multi-fixture-localization.md §6): place
 * several already-mapped fixtures relative to one another from ONE phone
 * capture, then fine-tune by hand.
 *
 *   1. Pick the fixtures (and which one is the room origin), through the bridge
 *      when one is paired, else directly (one fixture at a time).
 *   2. Read their maps + capture profiles; arm them all on a shared epoch with
 *      disjoint code ranges (group_capture); they flash together.
 *   3. Walk past them with the phone: per-fixture chips show who has been seen
 *      together with a neighbour enough; a live 3D room preview fills in.
 *   4. Finish: the joint solve, per-fixture quality (residual, ±σ, warnings),
 *      manual nudge / rotate per fixture, Save → set_fixture_pose on each.
 *
 * "Adjust by hand" skips the capture: it loads the stored poses for manual
 * alignment only.
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { appBuildInfo } from "../../buildInfo";
import { CvPipeline } from "../../cv/pipeline";
import { DetectorGL } from "../../cv/detect";
import {
  anchorPoses,
  flatToRoomPose,
  GroupCaptureSession,
  memberStartOptions,
  resolveGroupCapture,
  roomPoseToFlat,
  SHARED_FRAMES_GOAL,
  type GroupDetector,
  type GroupTiming,
  type MemberCapture,
} from "../../geom/groupCode";
import { nudgeRoomPose, applyRoomPose, type LocalizeResult, type RoomPose } from "../../geom/multiFixture";
import { BridgeLiveClient } from "../../net/bridgeLive";
import { LedMapperClient } from "../../net/client";
import { connectionRegistry, deviceHostKey } from "../../net/connectionRegistry";
import {
  BridgeGroupTransport,
  DirectGroupTransport,
  type ArmResult,
  type DirectDevice,
  type GroupMemberInfo,
  type GroupTransport,
} from "../../net/groupCapture";
import { nativeSocketFactory } from "../../net/nativeSocket";
import { bundleFixture, buildLocalizeBundle, type LocalizeBundle } from "../../solver/localizeBundle";
import { captureBundleStore } from "../../store/captureBundleStore";
import { debugModeEnabled } from "../../store/debugMode";
import { deviceStore, DEFAULT_CAPTURE_STRIDE } from "../../store/deviceStore";
import { prefs } from "../../store/prefs";
import { MediaStreamCaptureSource } from "../../xr/mediaStreamCapture";
import { NativeCaptureSource, nativeCaptureAvailable } from "../../xr/nativeCaptureSource";
import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";
import { Button, Card, Chip, toast } from "../kit";
import { FIXTURE_COLORS, RoomView, type RoomViewFixture } from "../roomView";
import { loadCreds } from "./bridgeLive";
import { installRoomLocalizeStyles } from "./roomLocalize.css";

const LIVE_SOLVE_MS = 2500;

export function RoomLocalizeScreen(router: Router): Screen {
  installRoomLocalizeStyles();
  const el = document.createElement("div");
  el.className = "screen room-screen";

  let bridge: BridgeLiveClient | null = null;
  let transport: GroupTransport | null = null;
  let members: GroupMemberInfo[] = [];
  let reference = 0;
  let roomName = "room";
  let armed = false;
  let unmounted = false;
  let stopCamera: (() => Promise<void>) | null = null;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let view: RoomView | null = null;
  // Review state: the poses being edited (room frame) per member.
  let poses: (RoomPose | null)[] = [];
  let result: LocalizeResult | null = null;
  let selected = 0;
  let runInfo: {
    session: GroupCaptureSession;
    arm: ArmResult;
    caps: MemberCapture[];
    timing: GroupTiming;
    startedAt: number;
  } | null = null;

  const h = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---------------------------------------------------------------------------
  // 1. Pick fixtures
  // ---------------------------------------------------------------------------

  async function renderPick(): Promise<void> {
    el.innerHTML = "";
    el.append(
      h("p", "room-dim", "Place mapped fixtures relative to each other from one phone capture. All of them flash at once; walk past them so each is filmed together with a neighbour."),
    );
    const creds = loadCreds();
    let candidates: { id: string; name: string; wssUrl?: string }[] = [];
    let viaBridge = false;
    if (creds) {
      try {
        bridge = new BridgeLiveClient(creds);
        await bridge.connect();
        candidates = bridge.players.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name }));
        viaBridge = true;
      } catch {
        bridge?.close();
        bridge = null;
      }
    }
    if (!viaBridge) candidates = deviceStore.list().map((d) => ({ id: d.id, name: d.label, wssUrl: d.wssUrl }));
    el.append(h("div", "room-sub", viaBridge ? "Through your bridge" : "Directly (one fixture at a time)"));
    if (candidates.length < 2) {
      el.append(Card(h("p", "", "You need at least two known fixtures, each already mapped.")));
      return;
    }
    const picked = new Set(candidates.map((c) => c.id));
    let ref = candidates[0]!.id;
    const list = h("div", "room-pick");
    const redraw = (): void => {
      list.innerHTML = "";
      for (const c of candidates) {
        const row = h("label", "room-pick-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = picked.has(c.id);
        cb.addEventListener("change", () => (cb.checked ? picked.add(c.id) : picked.delete(c.id), redraw()));
        const rb = document.createElement("input");
        rb.type = "radio";
        rb.name = "room-ref";
        rb.checked = ref === c.id;
        rb.disabled = !picked.has(c.id);
        rb.title = "Room origin";
        rb.addEventListener("change", () => ((ref = c.id), redraw()));
        row.append(cb, h("span", "room-pick-name", c.name), rb, h("span", "room-dim", ref === c.id ? "origin" : ""));
        list.append(row);
      }
    };
    redraw();
    const room = document.createElement("input");
    room.className = "sheet-input";
    room.placeholder = "Room name";
    room.value = roomName;
    const go = (manual: boolean) => async (): Promise<void> => {
      const chosen = candidates.filter((c) => picked.has(c.id));
      if (chosen.length < (manual ? 1 : 2)) {
        toast("Pick at least two fixtures", { error: true });
        return;
      }
      roomName = room.value.trim() || "room";
      transport = viaBridge && bridge
        ? new BridgeGroupTransport(bridge, chosen.map((c) => c.id))
        : new DirectGroupTransport(chosen.map((c) => ({ id: c.id, name: c.name, wssUrl: c.wssUrl! })), openDirect);
      await prepare(chosen.findIndex((c) => c.id === ref), manual);
    };
    el.append(
      list,
      room,
      h("div", "room-actions"),
    );
    el.lastElementChild!.append(
      Button({ label: "Read maps & continue", icon: "camera", onClick: () => void go(false)() }),
      Button({ label: "Adjust by hand", icon: "move", variant: "quiet", onClick: () => void go(true)() }),
    );
  }

  async function prepare(refIdx: number, manual: boolean): Promise<void> {
    el.innerHTML = "";
    const status = h("p", "room-dim", "Reading fixtures…");
    el.append(status);
    try {
      members = await transport!.prepare((done, total, name) => {
        status.textContent = name ? `Reading ${name} (${done + 1}/${total})…` : "Reading fixtures…";
      });
    } catch (e) {
      status.textContent = `Couldn't read the fixtures: ${(e as Error).message}`;
      return;
    }
    reference = Math.max(0, refIdx);
    if (manual) {
      poses = members.map((m) => flatToRoomPose(m.pose));
      if (!poses[reference]) poses[reference] = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
      result = null;
      renderReview();
      return;
    }
    renderReady();
  }

  // ---------------------------------------------------------------------------
  // 2. Ready: check maps + firmware, then arm
  // ---------------------------------------------------------------------------

  function renderReady(): void {
    el.innerHTML = "";
    const card = Card();
    let blocking = 0;
    members.forEach((m, i) => {
      const row = h("div", "room-member");
      const dot = h("span", "room-dot");
      dot.style.background = FIXTURE_COLORS[i % FIXTURE_COLORS.length]!;
      const why = m.error
        ? `can't reach it: ${m.error}`
        : !m.map
          ? "no stored map — map it first"
          : !m.features.includes("group_capture")
            ? "firmware too old for group capture — update it"
            : `${m.map.leds.length} LEDs mapped${m.profile ? " · capture profile" : ""}${m.pose ? " · posed" : ""}`;
      if (m.error || !m.map || !m.features.includes("group_capture")) blocking++;
      row.append(dot, h("span", "room-pick-name", m.name + (i === reference ? " (origin)" : "")), h("span", "room-dim", why));
      card.append(row);
    });
    el.append(card);
    if (blocking) {
      el.append(h("p", "room-warn", "Fix the fixtures above, or go back and leave them out."));
      el.append(Button({ label: "Back", variant: "quiet", onClick: () => void renderPick() }));
      return;
    }
    el.append(
      h("p", "room-dim", "Every fixture will flash its code at once. Hold the phone so at least two fixtures are in view, and move slowly past all of them — up and down a little too."),
      Button({ label: "Start capture", icon: "camera", block: true, onClick: () => void startCapture() }),
    );
  }

  async function startCapture(): Promise<void> {
    const okMembers = members.filter((m) => m.map);
    const session = new GroupCaptureSession(
      okMembers.map((m) => ({ id: m.id, name: m.name, ledCount: m.map!.ledCount || m.ledCount, map: m.map! })),
      reference,
    );
    const { members: caps, timing, detector } = resolveGroupCapture(
      okMembers.map((m) => ({
        profile: m.profile,
        fallback: {
          diffuse: prefs.getDiffuseEnabled(),
          strideSpacing: deviceStore.getCaptureStride(m.id) ?? DEFAULT_CAPTURE_STRIDE,
          anchorDensity: prefs.getDiffuseParams().anchorDensity,
        },
      })),
    );
    el.innerHTML = "";
    const status = h("p", "room-dim", "Starting the fixtures…");
    el.append(status);
    let arm: ArmResult;
    try {
      arm = await transport!.start(
        session.layout.slots.map((s, i) => ({ id: s.id, options: memberStartOptions(s, session.layout, caps[i]!, timing) })),
        (done, total) => (status.textContent = `Starting fixture ${Math.min(done + 1, total)}/${total}…`),
      );
    } catch (e) {
      status.textContent = `Couldn't start: ${(e as Error).message}`;
      return;
    }
    armed = true;
    const failed = arm.members.filter((m) => !m.ok);
    if (failed.length || !arm.codeParams) {
      await transport!.stop();
      armed = false;
      status.textContent = `Couldn't start ${failed.map((f) => members.find((m) => m.id === f.id)?.name ?? f.id).join(", ")}: ${failed[0]?.error ?? "no code params"}`;
      el.append(Button({ label: "Back", variant: "quiet", onClick: () => renderReady() }));
      return;
    }
    runInfo = { session, arm, caps, timing, startedAt: performance.now() };
    await runCamera(session, arm.codeParams, arm.epochLocalMs, caps.some((c) => c.diffuse), detector);
  }

  // ---------------------------------------------------------------------------
  // 3. Capture
  // ---------------------------------------------------------------------------

  async function runCamera(
    session: GroupCaptureSession,
    params: CodeParams,
    epochLocal: number,
    diffuse: boolean,
    prof: GroupDetector,
  ): Promise<void> {
    el.innerHTML = "";
    el.classList.add("room-screen--capture");
    const hud = h("div", "room-hud");
    const chips = h("div", "room-chips");
    const guide = h("p", "room-guide", "Keep two fixtures in view; move slowly.");
    view = new RoomView("room-inset");
    const finish = Button({ label: "Finish", icon: "check", onClick: () => void finishCapture() });
    const cancel = Button({ label: "Cancel", variant: "quiet", onClick: () => void abort() });
    hud.append(chips, guide, view.canvas, h("div", "room-actions"));
    hud.lastElementChild!.append(cancel, finish);
    el.append(hud);

    const bp = prefs.getDiffuseParams();
    // Stored capture profiles (#320) override the app-global diffuse params.
    const detectorOpts = {
      threshold: diffuse ? (prof.threshold ?? bp.threshold) : 0.6,
      downscale: prof.downscale ?? bp.downscale,
      flipV: bp.flipV,
      ...(diffuse ? { localContrast: { gain: prof.lcGain ?? bp.lcGain } } : {}),
    };
    let detectGl: WebGL2RenderingContext;
    let onFrame: (cb: Parameters<MediaStreamCaptureSource["onFrame"]>[0]) => void;
    try {
      const cached = prefs.getCalibratedK();
      if (nativeCaptureAvailable()) {
        const nc = new NativeCaptureSource({ kSeed: cached });
        await nc.start();
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        // Frames arrive pre-reduced; the detector only needs a throwaway context.
        const gl = document.createElement("canvas").getContext("webgl2");
        if (!gl) throw new Error("WebGL2 is unavailable");
        detectGl = gl;
        onFrame = (cb) => nc.onFrame(cb);
        stopCamera = async () => {
          await nc.stop();
          document.documentElement.style.background = "";
          document.body.style.background = "";
        };
        const det = new DetectorGL(detectGl, detectorOpts);
        nc.setDetectParams({ threshold: det.threshold, downscale: det.downscale });
        startLoop(det);
      } else {
        const ms = new MediaStreamCaptureSource({ kSeed: cached });
        await ms.start();
        ms.video.className = "room-video";
        el.prepend(ms.video);
        detectGl = ms.gl;
        onFrame = (cb) => ms.onFrame(cb);
        stopCamera = async () => {
          await ms.stop();
          ms.video.remove();
        };
        startLoop(new DetectorGL(detectGl, detectorOpts));
      }
    } catch (e) {
      toast(`Camera unavailable: ${(e as Error).message}`, { error: true });
      await abort();
      return;
    }

    function startLoop(detector: DetectorGL): void {
      // The phone clock IS the pattern clock (epoch chosen on it), so the
      // decoder maps capture times 1:1; its self-clocking alignment absorbs
      // camera latency and the common sync error.
      const pipeline = new CvPipeline(params, epochLocal, (t) => t, { denseRecords: true });
      const pending: DetectionRecord[] = [];
      pipeline.onDetections((r) => pending.push(...r));
      onFrame((f) => {
        const blobs = detector.detectFrame(f, {});
        if (f.reduced?.truncated) return;
        pipeline.step(blobs, { tCaptureMs: f.tCaptureMs, pose: f.pose, K: f.K, imgW: f.imgW, imgH: f.imgH });
        if (pending.length) {
          session.addRecords(pending.splice(0));
        }
      });
    }

    const paint = (): void => {
      const prog = session.progress();
      chips.innerHTML = "";
      session.members.forEach((m, i) => {
        const p = prog[i]!;
        const done = p.shared >= SHARED_FRAMES_GOAL;
        const c = Chip({ label: `${m.name} ${Math.min(p.shared, SHARED_FRAMES_GOAL)}/${SHARED_FRAMES_GOAL}` });
        c.style.borderColor = FIXTURE_COLORS[i % FIXTURE_COLORS.length]!;
        c.dataset["done"] = done ? "1" : "0";
        chips.append(c);
      });
      const missing = session.members.filter((_, i) => prog[i]!.shared < SHARED_FRAMES_GOAL).map((m) => m.name);
      guide.textContent = missing.length
        ? `Film ${missing.slice(0, 2).join(" and ")}${missing.length > 2 ? ` (+${missing.length - 2})` : ""} together with a neighbour.`
        : "Every fixture is covered — Finish when the preview looks right.";
    };
    liveTimer = setInterval(() => {
      paint();
      if (session.views().length < 5) return;
      // Interim solve on the main thread (small: <~0.5 s), warm-started.
      const r = session.solve({ maxViews: 80 });
      view?.update(
        roomFixtures(
          session.members.map((m) => m.name),
          session.members.map((m) => m.map),
          r.fixtures.map((f) => f.pose),
          r,
        ),
        r.cameras.map((c) => c.pose),
      );
    }, LIVE_SOLVE_MS);
    paint();
  }

  async function finishCapture(): Promise<void> {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    await stopCamera?.();
    stopCamera = null;
    el.classList.remove("room-screen--capture");
    el.innerHTML = "";
    el.append(h("p", "room-dim", "Stopping the fixtures and solving…"));
    if (armed) await transport!.stop().catch(() => undefined);
    armed = false;
    const run = runInfo!;
    let error: string | null = null;
    try {
      result = run.session.solve();
    } catch (e) {
      error = (e as Error).message;
      result = null;
    }
    const refStored = flatToRoomPose(members[reference]?.pose);
    poses = result ? anchorPoses(result.fixtures.map((f) => f.pose), reference, refStored) : members.map(() => null);
    const bundle = makeBundle(error);
    if (debugModeEnabled() && bundle.outcome !== "localized") {
      void captureBundleStore.save(bundle).then((m) => m && toast("Saved a localization debug bundle (Settings ▸ Debugging)"));
    }
    if (error) {
      el.innerHTML = "";
      el.append(h("p", "room-warn", `Solve failed: ${error}`), Button({ label: "Try again", onClick: () => renderReady() }));
      return;
    }
    renderReview(bundle);
  }

  function makeBundle(error: string | null): LocalizeBundle {
    const run = runInfo!;
    return buildLocalizeBundle({
      app: { version: appBuildInfo.version ?? null, gitCommit: appBuildInfo.gitCommit, gitDirty: appBuildInfo.gitDirty },
      capture: {
        ledCount: run.session.layout.codeSpace,
        transport: transport!.kind,
        layout: run.session.layout,
        codeParams: run.arm.codeParams,
        timing: run.timing,
        members: run.session.members.map((m, i) => {
          const info = members.find((x) => x.id === m.id);
          return { id: m.id, name: m.name, features: info?.features ?? [], capture: run.caps[i] ?? null, profile: info?.profile ?? null };
        }),
        arm: run.arm.members,
        epochLocalMs: run.arm.epochLocalMs,
        durationMs: performance.now() - run.startedAt,
        reference,
      },
      fixtures: run.session.models.map((m, i) =>
        bundleFixture(m, run.session.members[i]!.map.mapId ?? null, flatToRoomPose(members.find((x) => x.id === m.id)?.pose)),
      ),
      views: run.session.views(),
      options: { reference },
      result,
      error,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Review + manual alignment + save
  // ---------------------------------------------------------------------------

  function renderReview(bundle?: LocalizeBundle): void {
    el.innerHTML = "";
    view?.dispose();
    view = new RoomView("room-view");
    const maps = members.map((m) => m.map);
    const redraw = (): void => {
      view!.update(
        roomFixtures(
          members.map((m) => m.name),
          maps,
          poses,
          result,
        ),
        result?.cameras.map((c) => c.pose) ?? [],
      );
      view!.select(selected);
    };
    const list = h("div", "room-results");
    const fillList = (): void => {
      list.innerHTML = "";
      members.forEach((m, i) => {
        const f = result?.fixtures[i];
        const row = h("button", "room-result" + (i === selected ? " room-result--sel" : ""));
        (row as HTMLButtonElement).type = "button";
        const dot = h("span", "room-dot");
        dot.style.background = FIXTURE_COLORS[i % FIXTURE_COLORS.length]!;
        const status = !poses[i] ? "not placed" : f ? f.status : i === reference ? "origin" : "manual";
        const q = f && f.sigma ? ` · ±${(f.sigma.ledM * 100).toFixed(1)} cm · ${f.rmsPx.toFixed(1)} px` : "";
        row.append(dot, h("span", "room-pick-name", m.name), h("span", "room-dim", status + q));
        row.addEventListener("click", () => {
          selected = i;
          fillList();
          redraw();
        });
        list.append(row);
        if (f && f.warnings.length && i === selected) for (const w of f.warnings) list.append(h("p", "room-warn", w));
      });
    };
    const nudge = (d: Parameters<typeof nudgeRoomPose>[1]) => (): void => {
      const p = poses[selected];
      if (!p) {
        // An unplaced fixture starts next to the origin for manual placement.
        poses[selected] = { translation: [0.5, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
      }
      const cur = poses[selected]!;
      const leds = maps[selected]?.leds ?? [];
      const pts = leds.map((l) => applyRoomPose(cur, [l.xyz[0], l.xyz[1], l.xyz[2]]));
      const pivot: [number, number, number] = pts.length
        ? [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k]!, 0) / pts.length) as [number, number, number]
        : cur.translation;
      poses[selected] = nudgeRoomPose(cur, d, pivot);
      fillList();
      redraw();
    };
    const pad = h("div", "room-pad");
    const step = h("select", "room-step") as HTMLSelectElement;
    for (const [v, l] of [
      ["0.01", "1 cm / 1°"],
      ["0.05", "5 cm / 5°"],
      ["0.2", "20 cm / 15°"],
    ]) {
      const o = document.createElement("option");
      o.value = v!;
      o.textContent = l!;
      step.append(o);
    }
    const s = () => parseFloat(step.value);
    const deg = () => (s() >= 0.2 ? 15 : s() >= 0.05 ? 5 : 1);
    const b = (label: string, fn: () => Parameters<typeof nudgeRoomPose>[1]) =>
      Button({ label, variant: "quiet", onClick: () => nudge(fn())() });
    pad.append(
      step,
      b("←x", () => ({ dx: -s() })),
      b("x→", () => ({ dx: s() })),
      b("↓y", () => ({ dy: -s() })),
      b("y↑", () => ({ dy: s() })),
      b("−z", () => ({ dz: -s() })),
      b("+z", () => ({ dz: s() })),
      b("⟲ yaw", () => ({ yawDeg: deg() })),
      b("⟳ yaw", () => ({ yawDeg: -deg() })),
      b("pitch", () => ({ pitchDeg: deg() })),
      b("roll", () => ({ rollDeg: deg() })),
    );
    const summary = result
      ? h("p", "room-dim", `${result.fixtures.filter((f) => f.pose).length}/${members.length} placed · ${result.rmsPx.toFixed(2)} px · ${result.leveling === "reference_up" ? "levelled by gravity" : "origin fixture's +Y taken as up"}`)
      : h("p", "room-dim", "Manual alignment: pick a fixture, then nudge it.");
    const actions = h("div", "room-actions");
    actions.append(
      Button({ label: "Save poses", icon: "save", onClick: () => void save() }),
      Button({ label: "Recapture", variant: "quiet", onClick: () => renderReady() }),
    );
    if (bundle && debugModeEnabled())
      actions.append(
        Button({
          label: "Save debug bundle",
          variant: "quiet",
          onClick: () => void captureBundleStore.save(bundle).then((m) => toast(m ? "Bundle saved (Settings ▸ Debugging)" : "Couldn't save the bundle")),
        }),
      );
    for (const w of result?.warnings ?? []) el.append(h("p", "room-warn", w));
    el.append(summary, view.canvas, list, pad, actions);
    fillList();
    redraw();
  }

  async function save(): Promise<void> {
    const entries = members
      .map((m, i) => ({ id: m.id, pose: poses[i] ? roomPoseToFlat(roomName, poses[i]!) : null }))
      .filter((e) => e.pose !== null);
    try {
      const r = await transport!.setPoses(entries);
      const bad = r.filter((x) => !x.ok);
      if (bad.length) toast(`Saved ${r.length - bad.length}/${r.length}; ${bad[0]!.error}`, { error: true });
      else toast(`Saved ${r.length} poses in "${roomName}"`);
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, { error: true });
    }
  }

  async function abort(): Promise<void> {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    await stopCamera?.().catch(() => undefined);
    stopCamera = null;
    if (armed) await transport?.stop().catch(() => undefined);
    armed = false;
    el.classList.remove("room-screen--capture");
    if (!unmounted) renderReady();
  }

  // Direct opener: reuse the app's own socket for its device, else a short-lived
  // client registered as that device's socket owner (the prober multiplexes on it).
  async function openDirect(dev: DirectDevice): Promise<{ client: LedMapperClient; release: () => void }> {
    const own = appState.client;
    if (own && own.isConnected && deviceHostKey(own.url) === deviceHostKey(dev.wssUrl)) return { client: own, release: () => undefined };
    const factory = nativeSocketFactory();
    const c = new LedMapperClient(dev.wssUrl, {
      coldRetryLimit: 2,
      ...(factory ? { socketFactory: factory, certTrustPossible: false } : {}),
    });
    connectionRegistry.register(c);
    try {
      await c.connect();
    } catch (e) {
      connectionRegistry.unregister(c);
      c.close();
      throw e;
    }
    return {
      client: c,
      release: () => {
        connectionRegistry.unregister(c);
        c.close();
      },
    };
  }

  return {
    el,
    onMount: () => void renderPick(),
    onUnmount: () => {
      unmounted = true;
      void abort().finally(() => {
        bridge?.close();
        view?.dispose();
      });
      void router;
    },
  };
}

function roomFixtures(
  names: readonly string[],
  maps: readonly ({ leds: { xyz: number[] }[] } | null)[],
  poses: readonly (RoomPose | null)[],
  result: LocalizeResult | null,
): RoomViewFixture[] {
  return maps.map((m, i) => ({
    name: names[i] ?? `#${i + 1}`,
    leds: (m?.leds ?? []).map((l) => [l.xyz[0]!, l.xyz[1]!, l.xyz[2]!] as [number, number, number]),
    pose: poses[i] ?? null,
    status: result?.fixtures[i]?.status ?? "manual",
  }));
}
