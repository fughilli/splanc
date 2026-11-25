/**
 * Tune sheet (docs/ux/oobe-review.md): tapping an effect on the Effects tab
 * plays it on the connected fixture and opens this sheet with its adjustments
 * (the effect's sliders and colours, with readable names). The code editor is
 * one step further in ("Open in editor"), not the first thing a tap shows.
 *
 * Not connected: the sheet says so and offers "Connect a fixture" (the device
 * drawer). If a fixture connects while the sheet is open, the effect starts.
 */

import { Button, Sheet } from "../kit";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import { withDeviceLock } from "../../effects/devicePerf";
import { friendlyUniformName, starterBlurb } from "../../effects/quickPlay";
import { deviceEffects } from "../../store/deviceEffects";
import { deviceStore } from "../../store/deviceStore";
import { nowPlaying } from "../../store/nowPlaying";
import type { StoredEffect } from "../../store/effectStore";
import type { FxCompiled } from "../../fx/preview";
import { appState } from "../app/state";
import { meshPeers } from "../../net/mesh";
import { openDeviceSheet } from "./deviceSheet";
import { installEffectsHomeStyles } from "./effectsHome.css";
import type { Router } from "../app/router";

// The effect compiler, wired by app/main.ts (the worker client is browser-only,
// so this module stays importable from the CJS unit-test build).
type Compile = (source: string) => Promise<FxCompiled>;
let compileFx: Compile | null = null;
export function setTuneCompiler(fn: Compile): void {
  compileFx = fn;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fixtureName(): string {
  return appState.client?.welcome?.deviceName || deviceStore.active()?.label || "your fixture";
}

export function openEffectTune(router: Router, e: StoredEffect): void {
  installEffectsHomeStyles();
  let disposed = false;
  const sheet = Sheet(e.name, {
    onClose: () => {
      disposed = true;
      unsub();
    },
  });
  sheet.body.classList.add("fxtune");

  const blurb = starterBlurb(e.id);
  if (blurb) {
    const p = document.createElement("p");
    p.className = "fxtune-blurb";
    p.textContent = blurb;
    sheet.body.append(p);
  }

  const status = document.createElement("div");
  status.className = "fxtune-status";
  status.setAttribute("role", "status");
  const statusDot = document.createElement("span");
  statusDot.className = "fxtune-dot";
  const statusText = document.createElement("span");
  status.append(statusDot, statusText);

  // The one primary action slot (Connect / Try again), empty while playing.
  const actionSlot = document.createElement("div");
  actionSlot.className = "fxtune-action";

  const adjust = document.createElement("section");
  adjust.className = "fxtune-adjust";
  const adjustHead = document.createElement("h3");
  adjustHead.className = "fxtune-heading";
  adjustHead.textContent = "Adjust";
  const host = document.createElement("div");
  host.className = "fxtune-controls";
  adjust.append(adjustHead, host);
  adjust.hidden = true;

  const panel = new UniformPanel(
    host,
    (slot, value) => {
      const c = appState.client;
      if (c?.isConnected) c.live.setUniform(slot, value);
    },
    {
      label: friendlyUniformName,
      empty: "This effect has nothing to adjust.",
      onCommit: () => {
        const c = appState.client;
        if (c?.isConnected) c.live.commit();
      },
    },
  );

  const editor = Button({
    label: "Open in editor",
    icon: "edit",
    variant: "quiet",
    block: true,
    onClick: () => {
      sheet.close();
      router.navigate(`/effects/edit/${e.id}`);
    },
  });
  const editorNote = document.createElement("p");
  editorNote.className = "fxtune-note";
  editorNote.textContent = "Change the code, preview it on a map, or ask AI to remix it.";
  const footer = document.createElement("div");
  footer.className = "fxtune-footer";
  footer.append(editor, editorNote);

  sheet.body.append(status, actionSlot, adjust, footer);

  const setStatus = (kind: "ok" | "busy" | "off" | "err", text: string): void => {
    status.dataset["kind"] = kind;
    statusText.textContent = text;
  };

  let compiled: Promise<FxCompiled> | null = null;
  const compile = (): Promise<FxCompiled> => {
    compiled ??= compileFx
      ? compileFx(e.source)
      : Promise.resolve({ ok: false, bytecode: new Uint8Array(), uniforms: [], diagnostics: [] });
    return compiled;
  };

  let played = false;
  let playing = false;

  async function play(): Promise<void> {
    const c = appState.client;
    if (disposed || playing || !c?.isConnected) return;
    playing = true;
    actionSlot.replaceChildren();
    setStatus("busy", `Starting on ${fixtureName()}…`);
    try {
      const r = await compile();
      if (disposed) return;
      if (!r.ok) {
        setStatus("err", "This effect has an error. Open it in the editor to fix it.");
        return;
      }
      panel.setManifest(r.uniforms);
      await withDeviceLock(() => c.submitEffect(e.id, r.bytecode, true));
      if (disposed) return;
      const values = panel.values();
      if (values.length > 0) c.setUniforms(values);
      const devId = deviceStore.activeId();
      deviceEffects.markSent(devId, e.id);
      nowPlaying.set(devId, e.id);
      played = true;
      adjust.hidden = false;
      // Whole-mesh control (mesh M6): every member switched with it.
      const peers = c.meshAll ? meshPeers(c.meshState).length : 0;
      setStatus("ok", peers ? `Playing on ${fixtureName()} and ${peers} meshed fixture${peers === 1 ? "" : "s"}` : `Playing on ${fixtureName()}`);
    } catch (err) {
      if (disposed) return;
      setStatus("err", `Couldn't start it on ${fixtureName()}: ${msg(err)}`);
      actionSlot.replaceChildren(Button({ label: "Try again", block: true, onClick: () => void play() }));
    } finally {
      playing = false;
    }
  }

  function render(): void {
    if (disposed) return;
    const connected = appState.client?.isConnected === true && appState.status.state === "connected";
    if (connected) {
      if (!played) void play();
      return;
    }
    played = false;
    adjust.hidden = true;
    if (appState.status.state === "connecting") {
      setStatus("busy", `Connecting to ${fixtureName()}…`);
      actionSlot.replaceChildren();
      return;
    }
    setStatus("off", "No fixture connected. Connect one to play this on your lights.");
    actionSlot.replaceChildren(
      Button({
        label: "Connect a fixture",
        block: true,
        onClick: () => {
          sheet.close();
          openDeviceSheet();
        },
      }),
    );
  }

  const unsub = appState.subscribe(render);
  render();
}
