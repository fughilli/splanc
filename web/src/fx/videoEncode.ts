/**
 * Browser video encoding for the 64×64 effect preview tiles (FUG-80). Frames
 * arrive as RGBA byte buffers; the output is a looping .webm Blob.
 *
 * Preferred path: WebCodecs VideoEncoder (VP9, falling back to VP8) encodes
 * OFFLINE — as fast as the CPU allows, not real-time — with fixed 60 fps
 * timestamps, muxed by the vendored WebM muxer. This is what makes a 30 s clip
 * cheap to produce for a thumbnail.
 *
 * Fallback path: where WebCodecs is unavailable, MediaRecorder captures an
 * offscreen canvas in real time. Same API; slower and only as a safety net.
 */

import { muxWebm, type MuxFrame, type WebmCodec } from "./webmMuxer";

export interface EncodeSpec {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Produce frame `i` as tightly-packed RGBA (width*height*4 bytes). */
  frame: (i: number) => Uint8Array;
  /**
   * Optional cooperative yield between frames so a long render doesn't jank the
   * UI thread. Called every few frames with the frame index.
   */
  onProgress?: (i: number) => Promise<void> | void;
}

/** True when the fast offline WebCodecs path is usable in this browser. */
export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

// A generous bitrate for a 64×64 clip — trivially small in absolute terms but
// high enough that VP9 keeps the fine per-pixel detail the effects produce.
// (64×64 is tiny, so even this is visually lossless while keeping each cached
// clip small — a few hundred KB — so the IndexedDB cache stays light.)
const BITRATE = 800_000;
/** Periodic keyframes so the looping <video> can seek/restart cleanly. */
const KEYFRAME_INTERVAL = 60;

interface Candidate {
  codec: string; // WebCodecs codec string
  webm: WebmCodec; // Matroska CodecID
}
const CANDIDATES: Candidate[] = [
  { codec: "vp09.00.10.08", webm: "V_VP9" },
  { codec: "vp8", webm: "V_VP8" },
];

async function pickCodec(width: number, height: number, framerate: number): Promise<Candidate | null> {
  for (const c of CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        bitrate: BITRATE,
        framerate,
      });
      if (support.supported) return c;
    } catch {
      // isConfigSupported can throw on a malformed codec string; try the next.
    }
  }
  return null;
}

async function encodeWebCodecs(spec: EncodeSpec, cand: Candidate): Promise<Blob> {
  const { width, height, fps, frameCount } = spec;
  const frames: MuxFrame[] = [];
  let encodeError: unknown = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({
        data,
        timestampMs: chunk.timestamp / 1000, // µs → ms
        key: chunk.type === "key",
      });
    },
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure({
    codec: cand.codec,
    width,
    height,
    bitrate: BITRATE,
    framerate: fps,
    latencyMode: "quality",
  });

  const frameDurUs = 1_000_000 / fps;
  for (let i = 0; i < frameCount; i++) {
    if (encodeError) break;
    const rgba = spec.frame(i);
    const vf = new VideoFrame(rgba, {
      format: "RGBA",
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round(i * frameDurUs),
      duration: Math.round(frameDurUs),
    });
    encoder.encode(vf, { keyFrame: i % KEYFRAME_INTERVAL === 0 });
    vf.close();
    // Bound the in-flight queue so memory stays flat, and let the UI breathe.
    if (encoder.encodeQueueSize > 8 || i % 30 === 0) {
      await spec.onProgress?.(i);
    }
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError));

  frames.sort((a, b) => a.timestampMs - b.timestampMs);
  const durationMs = (frameCount / fps) * 1000;
  const bytes = muxWebm({ width, height, codec: cand.webm, frames, durationMs });
  // `bytes` fills its backing buffer exactly (muxWebm allocates to size), so the
  // ArrayBuffer is the whole payload; cast past TS 5.9's ArrayBufferLike generic.
  return new Blob([bytes.buffer as ArrayBuffer], { type: "video/webm" });
}

/**
 * Real-time MediaRecorder fallback: draw each frame onto an offscreen canvas at
 * `fps` and record the captured stream. Runs at wall-clock speed, so a 30 s clip
 * takes 30 s — only used when WebCodecs is missing.
 */
async function encodeMediaRecorder(spec: EncodeSpec): Promise<Blob> {
  const { width, height, fps, frameCount } = spec;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for MediaRecorder fallback");
  const img = ctx.createImageData(width, height);

  const stream = canvas.captureStream(fps);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
  if (!mime) throw new Error("no supported webm MediaRecorder mime");
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();

  const frameMs = 1000 / fps;
  for (let i = 0; i < frameCount; i++) {
    img.data.set(spec.frame(i));
    ctx.putImageData(img, 0, 0);
    await new Promise((r) => setTimeout(r, frameMs));
    await spec.onProgress?.(i);
  }
  rec.stop();
  await done;
  return new Blob(chunks, { type: "video/webm" });
}

/** Encode `frameCount` RGBA frames into a looping .webm Blob (see {@link EncodeSpec}). */
export async function encodeWebmVideo(spec: EncodeSpec): Promise<Blob> {
  if (webCodecsAvailable()) {
    const cand = await pickCodec(spec.width, spec.height, spec.fps);
    if (cand) return encodeWebCodecs(spec, cand);
  }
  return encodeMediaRecorder(spec);
}
