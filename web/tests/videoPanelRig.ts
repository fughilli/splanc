/**
 * Test rig for the editor's Video pane (src/effects/editor/videoTexture.ts) on
 * the fake DOM: builds a REAL VideoTexturePanel with its browser-only media
 * bits stubbed — the offscreen 2D canvas (drawImage recorded, getImageData
 * returning deterministic pixels and recording the read-back size), the <video>
 * element (play/pause counted, a 320×240 intrinsic size), the camera
 * (`navigator.mediaDevices.getUserMedia`), and a recording offline-preview sink.
 * Install the fake DOM before importing this module.
 */

import { asFake, textOf, type FakeElement } from "./fakeDom";
import { VideoTexturePanel, type PreviewSink } from "../src/effects/editor/videoTexture";

/** A compiled .fxb whose buffer table declares `bufs` (kind 1 = texture), with
 * the real 7-byte descriptor (kind, elem, comp, w, h — FUG-57). */
export function fxb(bufs: { kind: number; w: number; h: number }[]): Uint8Array {
  const out = new Uint8Array(18 + 1 + bufs.length * 7);
  const dv = new DataView(out.buffer);
  out.set([0x46, 0x58, 0x42, 0x31]); // "FXB1"
  dv.setUint8(4, 1); // version
  dv.setUint8(5, bufs.length ? 0x01 : 0x00); // flags: has a buffer table
  let off = 18; // empty manifest / consts / code
  dv.setUint8(off++, bufs.length);
  for (const b of bufs) {
    dv.setUint8(off, b.kind);
    dv.setUint8(off + 1, 4); // elem
    dv.setUint8(off + 2, 1); // comp (FUG-10 storage precision byte)
    dv.setUint16(off + 3, b.w, true);
    dv.setUint16(off + 5, b.h, true);
    off += 7;
  }
  return out;
}

/** Deterministic pixels for a w×h RGBA read-back. */
export const pixels = (w: number, h: number): Uint8ClampedArray =>
  Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i * 13 + 7) & 0xff);

export interface PreviewFrame {
  tex: number;
  width: number;
  height: number;
  rgba: number[];
}

export interface Rig {
  panel: VideoTexturePanel;
  video: FakeElement;
  canvas: FakeElement;
  /** drawImage argument lists, in order. */
  draws: unknown[][];
  /** getImageData read-back sizes [w, h], in order. */
  reads: [number, number][];
  preview: PreviewSink & { frames: PreviewFrame[] };
  media: { plays: number; pauses: number };
}

/** Build a panel, capturing its offscreen canvas + video so the browser-only
 * media/canvas calls can be stubbed. */
export function rig(): Rig {
  const canvases: FakeElement[] = [];
  const doc = document as unknown as Record<string, unknown>;
  const create = document.createElement;
  doc["createElement"] = function (this: Document, tag: string) {
    const el = create.call(document, tag);
    if (tag === "canvas") canvases.push(asFake(el));
    return el;
  };
  let panel: VideoTexturePanel;
  try {
    panel = new VideoTexturePanel();
  } finally {
    delete doc["createElement"];
  }
  document.body.appendChild(panel.node);
  const canvas = canvases[0]!;
  const ctx = canvas.getContext("2d")!;
  const draws: unknown[][] = [];
  const reads: [number, number][] = [];
  ctx["drawImage"] = (...a: unknown[]) => void draws.push(a);
  ctx["getImageData"] = (_x: number, _y: number, w: number, h: number) => {
    reads.push([w, h]);
    return { width: w, height: h, data: pixels(w, h) };
  };

  const video = asFake(panel.node.querySelector("video"));
  const media = { plays: 0, pauses: 0 };
  video["play"] = async () => void media.plays++;
  video["pause"] = () => void media.pauses++;
  video["videoWidth"] = 320;
  video["videoHeight"] = 240;

  const frames: PreviewFrame[] = [];
  const preview = {
    frames,
    setTexture(tex: number, width: number, height: number, rgba: Uint8Array) {
      frames.push({ tex, width, height, rgba: [...rgba] });
    },
  };
  return { panel, video, canvas, draws, reads, preview, media };
}

export function button(root: HTMLElement, label: string): FakeElement {
  const b = asFake(root).querySelectorAll("button").find((x) => textOf(x) === label);
  if (!b) throw new Error(`no "${label}" button`);
  return b;
}
export const hint = (r: Rig): FakeElement => asFake(r.panel.node.querySelector("p.fxedit-muted"));
export const controls = (r: Rig): FakeElement => asFake(r.panel.node.querySelector(".fxvid-controls"));
export const stats = (r: Rig): string => textOf(r.panel.node.querySelector(".fxvid-stats"));

/** Let the panel's async source setup (camera/file) settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

// -- camera ---------------------------------------------------------------------

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

export const camera = {
  calls: [] as unknown[],
  trackStops: 0,
  stream: null as unknown,
  /** Install a camera; `getUserMedia === null` → no camera API at all. */
  install(getUserMedia?: ((c: unknown) => Promise<unknown>) | null): void {
    this.calls = [];
    this.trackStops = 0;
    const stream = { getTracks: () => [{ stop: () => void camera.trackStops++ }] };
    this.stream = stream;
    const gum =
      getUserMedia === undefined
        ? async (c: unknown) => {
            camera.calls.push(c);
            return stream;
          }
        : getUserMedia;
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "test", mediaDevices: gum ? { getUserMedia: gum } : undefined },
      configurable: true,
      writable: true,
    });
  },
  restore(): void {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  },
};
