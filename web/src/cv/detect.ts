/**
 * M6 detect stage, GPU half (design doc §6 M6): a WebGL2 threshold +
 * downsample pass over the camera texture, read back at reduced resolution,
 * then CPU connected components (ccl.ts) for sub-pixel centroids.
 *
 * The camera texture lives in the XR session's GL context, so the detector is
 * constructed with that same context (see WebXRCaptureSource.gl).
 *
 * Resolution/readback trade-off: the pass downsamples by `downscale` (default
 * 2) with linear filtering — a 2×2 box filter — and soft-thresholds luminance
 * (values below `threshold` → 0, above keep their luminance). Because the box
 * filter is linear, intensity-weighted centroids computed at half resolution
 * track the full-resolution centroid to well under a pixel, while readback
 * drops to a quarter of the bytes. Synchronous readPixels of ~640×360 RGBA is
 * acceptable at 30 fps for the MVP; a PBO/fence pipeline is a later
 * optimization behind this same interface.
 */

import { connectedComponents } from "./ccl";
import { AdaptiveDiffuseGL } from "./diffuseDetectGL";
import { adaptiveParamsForDownscale, DEFAULT_ADAPTIVE_DIFFUSE, type AdaptiveDiffuseParams, type NoiseFloor } from "./diffuseDetect";
import type { SceneStats } from "./exposure";
import type { Blob } from "./types";

const VS = `#version 300 es
layout(location = 0) in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
uniform sampler2D cam;
uniform float threshold;
// Diffuse-mode local-contrast prefilter (design: diffuse_capture Stage A,
// validated in web/src/sim/render.ts reduceToDetect + web/tests/diffuse_sim).
// bgGain 0 = off. A diffuser SPREADS each LED spot — lowering its peak and
// flattening its edges — so a fixed global threshold misses the dimmed spots and
// bleeds neighbors together. Subtracting a low-frequency background (a top-hat /
// DoG high-pass) restores the per-spot peak, the luma derivative, AND the
// bleed-corrupted hue before the threshold + the CPU stage's per-blob chroma read.
uniform float bgGain;
uniform vec2 bgStep; // uv offset between the 5x5 background-estimate taps
in vec2 uv;
out vec4 outColor;
void main() {
  vec3 rgb = texture(cam, uv).rgb;
  if (bgGain > 0.0) {
    vec3 bg = vec3(0.0);
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        bg += texture(cam, uv + bgStep * vec2(float(i), float(j))).rgb;
      }
    }
    rgb = max(rgb - bgGain * (bg / 25.0), vec3(0.0));
  }
  // Max channel: robust for saturated white AND colored LEDs.
  float lum = max(rgb.r, max(rgb.g, rgb.b));
  float m = lum >= threshold ? 1.0 : 0.0;
  // rgb: per-pixel color for the CPU stage's per-blob chroma (hue-coded
  // fixtures); alpha: masked luminance, the CCL fill/weight channel.
  outColor = vec4(rgb * m, m * lum);
}`;

/**
 * A frame whose threshold/downsample pass was already run by the capture source
 * instead of by this detector's GPU pass — the native iOS path, where the app owns
 * the AVCaptureSession and WebKit never sees the camera (design doc §4.7).
 *
 * `detect` is byte-identical in layout to what {@link DetectorGL.detect}'s
 * readPixels produces (RGBA, sub-threshold pixels all-zero, alpha = masked
 * luminance) so it feeds the same {@link connectedComponents} unchanged. The one
 * difference is row order: this buffer's row 0 is the image TOP, so blob v needs
 * no flip — unlike the GL readback, whose row 0 is the render target's bottom.
 */
export interface ReducedFrame {
  detect: Uint8Array;
  w: number;
  h: number;
  /** The source clipped its encoding — too much of the frame was above threshold,
   * so this frame's detections are incomplete. Surfaced, never silently dropped. */
  truncated: boolean;
  /** Unthresholded measure buffer: rgb = color, alpha = raw luminance. */
  measure: Uint8Array;
  measureW: number;
  measureH: number;
}

/** The subset of a CaptureFrame the detector needs; kept structural so cv/ doesn't
 * depend on xr/. */
export interface DetectInput {
  texture: WebGLTexture | null;
  imgW: number;
  imgH: number;
  reduced?: ReducedFrame | undefined;
}

export interface DetectorOptions {
  /** Integer downsample factor for the threshold pass. */
  downscale?: number;
  /** Luminance threshold in [0, 1]. LEDs should be the brightest thing (§5). */
  threshold?: number;
  /** Component size limits, in detection-resolution pixels. */
  minArea?: number;
  maxArea?: number;
  maxBlobs?: number;
  /**
   * Reject blobs whose bounding-box aspect ratio (long/short side) exceeds
   * this. Filming a display produces bright HORIZONTAL BANDS (panel
   * refresh/PWM beating the rolling shutter) that are code-correlated and
   * quasi-static, so they defeat every temporal filter — but they are
   * strongly elongated where LEDs are compact. Observed live 2026-07-05:
   * same-cycle records sharing one image row across the full width.
   */
  maxAspect?: number;
  /**
   * Diffuse-capture mode: a local-contrast top-hat prefilter before the
   * threshold (design: diffuse_capture Stage A). `gain` ≈ 1 fully removes the
   * diffuser's DC lift; `radiusPx` is the background scale in DETECTION px
   * (default 8, the Stage-A tuned value). Omit ⇒ off (the legacy detector).
   * Pair with a LOW `threshold` (~0.18): the top-hat makes detection local, so
   * the threshold reads residual contrast, not absolute brightness.
   */
  localContrast?: { gain: number; radiusPx?: number } | undefined;
  /**
   * Which detector diffuse mode (localContrast gain > 0) runs. "adaptive" (the
   * default): cv/diffuseDetect.ts — spot-scale DoG + a per-frame noise floor +
   * local-peak split, ~2.3x the legacy recall on real diffused-rope frames
   * (web/tests/diffuseRope.test.ts). "legacy": the single-pass top-hat above,
   * kept for A/B (`?diffusedet=legacy`). Falls back to legacy, and says so, on a
   * context without EXT_color_buffer_float.
   */
  diffuseMode?: "adaptive" | "legacy";
  adaptiveParams?: AdaptiveDiffuseParams;
  /**
   * Whether the camera texture's v=0 row is the image BOTTOM (GL-style) —
   * then blob v must be flipped to the §7.4 top-left origin. Camera-texture
   * row order is device/driver territory; validated on-device 2026-07-03:
   * Chrome/ARCore camera-access delivers the texture bottom-up, so this
   * defaults to TRUE (a wrong setting shows up as the solve overlay
   * Y-mirrored against the passthrough, plus huge M3 reprojection residuals,
   * since poses and pixels disagree about "up"). Toggleable from the capture
   * page (`?flipv=0`) if some device disagrees.
   */
  flipV?: boolean;
}

/** Detector knobs the CCL + blob mapping needs (see {@link reducedToBlobs}). */
export interface ReduceToBlobsOptions {
  minArea: number;
  maxArea: number;
  maxBlobs: number;
  maxAspect: number;
  /** Also compute the chroma-weighted halo hue (cr/cg/cb) — the trace path. */
  stats?: boolean;
}

/**
 * Connected components + blob mapping over a reduced detect buffer (RGBA:
 * `rgb·mask` in 0..2, masked luminance in alpha), the CPU half every detect path
 * ends in. `buf` is at detection resolution `w`×`h`; `ds` scales centroids back to
 * full-res px; `flipV` mirrors v to the top-left origin (GL readback rows are
 * bottom-up, a pre-reduced buffer is top-down). Pure — so the synthetic diffuse
 * simulator (web/src/sim) drives the exact production detector core, no port.
 */
export function reducedToBlobs(
  buf: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  ds: number,
  imgH: number,
  flipV: boolean,
  opts: ReduceToBlobsOptions,
): Blob[] {
  // Fill/weight channel is alpha (masked luminance); RGB carries color.
  // splitOversized: a washed-out strip merges every halo into one giant
  // component that maxArea used to silently drop — taking every LED with
  // it (2026-07-12 capture screenshot: one 98k-px component spanned the
  // frame at threshold 0.6, beyond even the threshold servo's 0.9 cap).
  // The cut ladders re-threshold such components into per-core blobs.
  const comps = connectedComponents(buf, w, h, 4, 3, {
    minArea: opts.minArea,
    maxArea: opts.maxArea,
    maxBlobs: opts.maxBlobs,
    colorBase: 0,
    stats: opts.stats === true,
    splitOversized: true,
  });

  return comps
    .filter((c) => Math.max(c.w, c.h) <= opts.maxAspect * Math.min(c.w, c.h))
    .map((c) => {
      const blob: Blob = {
        u: c.x * ds,
        v: flipV ? imgH - c.y * ds : c.y * ds,
        intensity: c.intensity,
        area: c.area * ds * ds,
        w: c.w * ds,
        h: c.h * ds,
        // Always present: this call passes colorBase.
        r: c.r!,
        g: c.g!,
        b: c.b!,
      };
      if (c.split) blob.split = true;
      // Always present (CCL computes them unconditionally): the brightness
      // servo reads satFrac each frame.
      blob.peak = c.peak!;
      blob.satFrac = c.satFrac!;
      if (opts.stats) {
        // The chroma-weighted color is only computed under stats:true.
        blob.cr = c.cr!;
        blob.cg = c.cg!;
        blob.cb = c.cb!;
      }
      return blob;
    });
}

export class DetectorGL {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly fbo: WebGLFramebuffer;
  private readonly targetTex: WebGLTexture;
  private readonly uThreshold: WebGLUniformLocation;
  private readonly uCam: WebGLUniformLocation;
  private readonly uBgGain: WebGLUniformLocation;
  private readonly uBgStep: WebGLUniformLocation;
  /** Diffuse-mode prefilter gain (0 = off) and background radius (detection px).
   * The gain changes when a capture switches diffuse mode live (setLocalContrast). */
  private bgGain: number;
  private readonly bgRadiusPx: number;
  /** The adaptive diffuse detector, when diffuseMode is "adaptive" and the
   * context supports it; used whenever the diffuse prefilter is on. */
  private adaptive: AdaptiveDiffuseGL | null = null;
  private readonly diffuseMode: "adaptive" | "legacy";
  /** The adaptive params as tuned (at downscale 2), before scaling to `downscale`. */
  private readonly adaptiveBase: AdaptiveDiffuseParams;
  private targetW = 0;
  private targetH = 0;
  private readback: Uint8Array = new Uint8Array(0);
  // Separate tiny target for the unthresholded measure() pass.
  private measureTex: WebGLTexture | null = null;
  private measureFbo: WebGLFramebuffer | null = null;
  private measureW = 0;
  private measureH = 0;
  private measureBuf: Uint8Array = new Uint8Array(0);
  // Full-resolution readback target for grabFrame() (offline-replay capture).
  private grabTex: WebGLTexture | null = null;
  private grabFbo: WebGLFramebuffer | null = null;
  private grabW = 0;
  private grabH = 0;
  private grabBuf: Uint8Array = new Uint8Array(0);

  /** Camera px per detection px. Changes only through {@link setDownscale}. */
  downscale: number;
  threshold: number;
  flipV: boolean;
  private readonly minArea: number;
  private readonly maxArea: number;
  private readonly maxBlobs: number;
  private readonly maxAspect: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    opts: DetectorOptions = {},
  ) {
    this.downscale = opts.downscale ?? 2;
    this.threshold = opts.threshold ?? 0.6;
    this.flipV = opts.flipV ?? true;
    this.minArea = opts.minArea ?? 2;
    this.maxArea = opts.maxArea ?? 4000;
    this.maxBlobs = opts.maxBlobs ?? 2048;
    this.maxAspect = opts.maxAspect ?? 3;
    this.bgGain = opts.localContrast?.gain ?? 0;
    this.bgRadiusPx = opts.localContrast?.radiusPx ?? 8;
    this.diffuseMode = opts.diffuseMode ?? "adaptive";
    this.adaptiveBase = opts.adaptiveParams ?? DEFAULT_ADAPTIVE_DIFFUSE;
    if (this.diffuseMode === "adaptive") {
      if (AdaptiveDiffuseGL.supported(gl)) {
        const p = adaptiveParamsForDownscale(this.adaptiveBase, this.downscale);
        this.adaptive = new AdaptiveDiffuseGL(gl, p, this.downscale);
      }
      else console.warn("[detect] EXT_color_buffer_float unavailable: diffuse mode uses the legacy top-hat prefilter");
    }

    this.program = buildProgram(gl, VS, FS);
    this.uThreshold = gl.getUniformLocation(this.program, "threshold")!;
    this.uCam = gl.getUniformLocation(this.program, "cam")!;
    this.uBgGain = gl.getUniformLocation(this.program, "bgGain")!;
    this.uBgStep = gl.getUniformLocation(this.program, "bgStep")!;

    // Fullscreen triangle.
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.targetTex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
  }

  /**
   * Change the detection resolution (camera px per detection px) — the GPU-cost
   * lever of the low-end tier ({@link planDetectDownscale}). The adaptive
   * detector's radii rescale to span the same image distance
   * (adaptiveParamsForDownscale). Call between captures or in the probe, never
   * mid-decode: blob areas and centroid precision change with it.
   */
  setDownscale(ds: number): void {
    const d = Math.max(1, Math.round(ds));
    if (d === this.downscale) return;
    this.downscale = d;
    if (this.adaptive !== null) {
      this.adaptive = new AdaptiveDiffuseGL(this.gl, adaptiveParamsForDownscale(this.adaptiveBase, d), d);
    }
  }

  /** Turn the diffuse-mode local-contrast prefilter on (gain > 0) or off (0)
   * mid-capture — the capture screen's live diffuse toggle. */
  setLocalContrast(gain: number): void {
    this.bgGain = Math.max(0, gain);
  }

  /** Whether diffuse frames SHOULD go through the adaptive detector (diffuse on,
   * adaptive mode) — what a pre-reduced source (the iOS native reducer) runs,
   * whatever this context's GL support. */
  get adaptiveWanted(): boolean {
    return this.diffuseMode === "adaptive" && this.bgGain > 0;
  }

  /** Whether diffuse frames currently go through the adaptive detector. */
  get adaptiveActive(): boolean {
    return this.adaptive !== null && this.bgGain > 0;
  }

  /** The adaptive detector's last noise floor (null until it has run). */
  get lastNoise(): NoiseFloor | null {
    return this.adaptive?.lastNoise ?? null;
  }

  /**
   * Run detection on a camera texture of `imgW`×`imgH`. Returns blobs in
   * full-resolution pixels, origin top-left (§7.4) — the readback's GL
   * bottom-left rows are flipped here.
   */
  detect(texture: WebGLTexture, imgW: number, imgH: number, opts: { stats?: boolean } = {}): Blob[] {
    const gl = this.gl;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const t0 = performance.now();
    let buf: Uint8Array;
    let w: number;
    let h: number;
    let tRead: number;
    if (this.adaptive !== null && this.bgGain > 0) {
      w = Math.max(1, Math.round(imgW / this.downscale));
      h = Math.max(1, Math.round(imgH / this.downscale));
      tRead = performance.now();
      buf = this.adaptive.run(texture, w, h);
    } else {
      const r = this.renderDetect(texture, imgW, imgH);
      w = r.w;
      h = r.h;
      if (this.readback.length !== w * h * 4) this.readback = new Uint8Array(w * h * 4);
      tRead = performance.now();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readback);
      buf = this.readback;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    const tCcl = performance.now();
    // readPixels row 0 is the render target's bottom row, and the fragment
    // shader samples the camera texture identity-mapped — so buffer row 0
    // holds the camera texture's v=0 row. Whether that row is the image top
    // or bottom is what `flipV` encodes (see DetectorOptions.flipV).
    const blobs = this.blobsFromBuffer(buf, w, h, this.downscale, imgH, this.flipV, opts);
    const t1 = performance.now();
    this.lastProfile = { submitMs: tRead - t0, readMs: tCcl - tRead, cclMs: t1 - tCcl, inFlight: 0 };
    return blobs;
  }

  /**
   * Queue the detect pass(es) for one camera texture without reading anything
   * back (the pipelined path, {@link DetectPipeline}). The detect buffer is then
   * in `fbo` at w x h; `stats`, when non-null, is the adaptive detector's packed
   * noise-statistics target, to be read back (RGBA/FLOAT) and handed to
   * {@link acceptStats}. Leaves `fbo` bound; the caller restores its state.
   */
  renderDetect(
    texture: WebGLTexture,
    imgW: number,
    imgH: number,
  ): { fbo: WebGLFramebuffer; w: number; h: number; stats: { fbo: WebGLFramebuffer; w: number; h: number } | null } {
    const gl = this.gl;
    const w = Math.max(1, Math.round(imgW / this.downscale));
    const h = Math.max(1, Math.round(imgH / this.downscale));
    if (this.adaptive !== null && this.bgGain > 0) {
      const refresh = this.adaptive.render(texture, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.adaptive.outFbo);
      return { fbo: this.adaptive.outFbo, w, h, stats: refresh ? this.adaptive.statsTarget : null };
    }
    this.ensureTarget(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform1f(this.uThreshold, this.threshold);
    // Diffuse-mode top-hat: sample the 5×5 background at half the configured
    // radius per tap (±2 taps → ±radius), in full-res normalized uv.
    gl.uniform1f(this.uBgGain, this.bgGain);
    if (this.bgGain > 0) {
      const stepFull = (this.bgRadiusPx * this.downscale) / 2;
      gl.uniform2f(this.uBgStep, stepFull / imgW, stepFull / imgH);
    }
    this.drawCamera(texture);
    return { fbo: this.fbo, w, h, stats: null };
  }

  /** The adaptive detector's packed stats texels, read back from
   * {@link renderDetect}'s `stats` target: the next frames' noise floor. */
  acceptStats(texels: Float32Array): void {
    this.adaptive?.acceptStats(texels);
  }

  /** Main-thread cost split of the last {@link detect} (or pipelined frame). */
  lastProfile: DetectProfile | null = null;

  /** Bind the camera texture (LINEAR, clamped) and draw the fullscreen pass. */
  private drawCamera(texture: WebGLTexture): void {
    const gl = this.gl;
    gl.uniform1i(this.uCam, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Run detection on whichever form this frame arrived in: a camera texture (the
   * GPU path runs the threshold pass here) or an already-reduced buffer (the
   * native iOS path ran it in the capture source). Both end in the same CCL.
   */
  detectFrame(f: DetectInput, opts: { stats?: boolean } = {}): Blob[] {
    const r = f.reduced;
    if (!r) return this.detect(f.texture!, f.imgW, f.imgH, opts);
    // The reduced buffer's row 0 is the image top, so no v-flip — and its own
    // width fixes the downsample factor, rather than this.downscale, so the two
    // can't silently disagree.
    const ds = r.w > 0 ? f.imgW / r.w : this.downscale;
    return this.blobsFromBuffer(r.detect, r.w, r.h, ds, f.imgH, false, opts);
  }

  /** Scene stats from whichever form this frame arrived in (see detectFrame). */
  measureFrame(f: DetectInput): SceneStats {
    const r = f.reduced;
    if (!r) return this.measure(f.texture!, f.imgW, f.imgH);
    // Keep lastMeasureFrame() working for the trace sink on this path too.
    this.measureBuf = r.measure;
    this.measureW = r.measureW;
    this.measureH = r.measureH;
    return sceneStatsFromLuma(r.measure, r.measureW * r.measureH);
  }

  /** CCL + blob mapping, shared by the GPU, pipelined and pre-reduced paths. */
  blobsFromBuffer(
    buf: Uint8Array,
    w: number,
    h: number,
    ds: number,
    imgH: number,
    flipV: boolean,
    opts: { stats?: boolean },
  ): Blob[] {
    return reducedToBlobs(buf, w, h, ds, imgH, flipV, {
      minArea: this.minArea,
      maxArea: this.maxArea,
      maxBlobs: this.maxBlobs,
      maxAspect: this.maxAspect,
      stats: opts.stats === true,
    });
  }

  /**
   * Unthresholded scene-luminance statistics for exposure monitoring
   * (cv/exposure.ts): the same pass with threshold 0 into a tiny fixed
   * target, so the readback (~64×36 RGBA) costs a fraction of a detect().
   * Run every few frames, not per frame — scene stats move at AE speed.
   */
  measure(texture: WebGLTexture, imgW: number, imgH: number): SceneStats {
    const gl = this.gl;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const { w, h } = this.renderMeasure(texture, imgW, imgH);
    if (this.measureBuf.length !== w * h * 4) this.measureBuf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.measureBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    return sceneStatsFromLuma(this.measureBuf, w * h);
  }

  /** Queue the {@link measure} pass without reading it back (pipelined path);
   * leaves its target bound. Hand the readback to {@link acceptMeasure}. */
  renderMeasure(texture: WebGLTexture, imgW: number, imgH: number): { fbo: WebGLFramebuffer; w: number; h: number } {
    const gl = this.gl;
    const w = MEASURE_W;
    const h = Math.max(1, Math.round((MEASURE_W * imgH) / imgW));
    this.ensureMeasureTarget(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.measureFbo!);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform1f(this.uThreshold, 0.0); // unthresholded: alpha = raw luminance
    gl.uniform1f(this.uBgGain, 0.0); // measure raw scene luma, never prefiltered
    this.drawCamera(texture);
    return { fbo: this.measureFbo!, w, h };
  }

  /** A pipelined measure readback: becomes {@link lastMeasureFrame}. */
  acceptMeasure(rgba: Uint8Array, w: number, h: number): SceneStats {
    if (this.measureBuf.length !== rgba.length) this.measureBuf = new Uint8Array(rgba.length);
    this.measureBuf.set(rgba);
    this.measureW = w;
    this.measureH = h;
    return sceneStatsFromLuma(this.measureBuf, w * h);
  }

  /**
   * The last {@link measure} pass's raw downsampled frame (RGB color, alpha =
   * unthresholded luminance) — a small color thumbnail for offline trace
   * inspection (seeing bloom shape/color). Call right after measure(); returns
   * an empty buffer if measure() hasn't run. The buffer is reused, so the
   * caller must copy (the trace sink base64-encodes it immediately).
   */
  lastMeasureFrame(): { w: number; h: number; rgba: Uint8Array } {
    return { w: this.measureW, h: this.measureH, rgba: this.measureBuf };
  }

  /**
   * Read back the camera frame at FULL resolution, byte-exact to what
   * `detect()` samples: the same pass with threshold 0, whose fragment shader
   * writes the raw camera rgb to the color channels (`outColor = vec4(rgb, lum)`
   * when the mask is 1). This is the detector's true INPUT — captured for the
   * offline replay harness so the whole CV pipeline (threshold/downsample →
   * CCL → tracker → decoder) can be re-run and tuned against real frames.
   * Returns a reused RGBA buffer (RGB = camera color, alpha = luminance);
   * copy/compress it before the next call. GL row order (v=0 = the camera
   * texture's first row) matches detect()'s readback, so the same `flipV`
   * applies on replay.
   */
  grabFrame(texture: WebGLTexture, imgW: number, imgH: number): { w: number; h: number; rgba: Uint8Array } {
    const gl = this.gl;
    const w = Math.max(1, imgW);
    const h = Math.max(1, imgH);
    this.ensureGrabTarget(w, h);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.grabFbo!);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform1f(this.uThreshold, 0.0); // mask = 1 everywhere -> rgb passes through
    gl.uniform1f(this.uBgGain, 0.0); // raw grab, never prefiltered
    gl.uniform1i(this.uCam, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    if (this.grabBuf.length !== w * h * 4) this.grabBuf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.grabBuf);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);

    return { w, h, rgba: this.grabBuf };
  }

  private ensureGrabTarget(w: number, h: number): void {
    const gl = this.gl;
    if (this.grabFbo !== null && w === this.grabW && h === this.grabH) return;
    this.grabW = w;
    this.grabH = h;
    if (this.grabTex === null) this.grabTex = gl.createTexture()!;
    if (this.grabFbo === null) this.grabFbo = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, this.grabTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.grabFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.grabTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private ensureMeasureTarget(w: number, h: number): void {
    const gl = this.gl;
    if (this.measureFbo !== null && w === this.measureW && h === this.measureH) return;
    this.measureW = w;
    this.measureH = h;
    if (this.measureTex === null) this.measureTex = gl.createTexture()!;
    if (this.measureFbo === null) this.measureFbo = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, this.measureTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.measureFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.measureTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private ensureTarget(w: number, h: number): void {
    if (w === this.targetW && h === this.targetH) return;
    const gl = this.gl;
    this.targetW = w;
    this.targetH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.targetTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.targetTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

/** Main-thread cost of one detected frame, ms. */
export interface DetectProfile {
  /** Queueing the GPU passes (and, synchronous path, nothing else). */
  submitMs: number;
  /** Waiting for / copying the readback. Pipelined: the copy of an already
   * finished frame, ~0 wait. Synchronous: the whole GPU frame + the copy. */
  readMs: number;
  /** Connected components + blob mapping. */
  cclMs: number;
  /** Frames still on the GPU when this one was delivered (pipelined). */
  inFlight: number;
}

/** One frame delivered by {@link DetectPipeline.collect}, in submission order. */
export interface DetectedFrame<T> {
  tag: T;
  blobs: Blob[];
  /** Present when the frame was submitted with `measure: true`. */
  scene?: SceneStats | undefined;
  /** ms from submit to delivery (GPU latency + waiting for the next collect). */
  latencyMs: number;
}

interface Slot<T> {
  tag: T;
  tSubmit: number;
  /** null for a pre-reduced frame (no GPU work: ready at once). */
  sync: WebGLSync | null;
  pbo: WebGLBuffer | null;
  w: number;
  h: number;
  imgH: number;
  ds: number;
  flipV: boolean;
  stats: { pbo: WebGLBuffer; bytes: number } | null;
  measure: { pbo: WebGLBuffer; w: number; h: number } | null;
  reduced: ReducedFrame | null;
  measureNow?: SceneStats;
}

/** Detection downscales the low-end tier walks (2 = full quality; 3 and 4 cut
 * the GPU work to ~44% / ~25%). Measured on the diffuse_rope suite (CPU
 * reference): recall 0.673 / 0.668 / 0.662, median centre error 1.72 / 1.72 /
 * 1.78 px, 4-symbol hue classification unchanged — far less than the decode
 * yield a phone loses shedding a third of its frames. */
export const DETECT_DOWNSCALE_LADDER = [2, 3, 4] as const;
/** Step down when more than this fraction of camera frames was shed because the
 * GPU was behind. */
export const DETECT_SHED_MAX = 0.15;

/**
 * Detector tier for the measured GPU throughput: given the probe's submitted and
 * shed frame counts at downscale `current`, the downscale to probe next — or
 * null to keep `current` (fast enough, or already the cheapest rung). A ladder
 * walk at probe time only: the tier is fixed before the pattern runs.
 */
export function planDetectDownscale(current: number, m: { submitted: number; shed: number }): number | null {
  const total = m.submitted + m.shed;
  if (total < 20) return null; // too few frames to judge
  if (m.shed / total <= DETECT_SHED_MAX) return null;
  const next = DETECT_DOWNSCALE_LADDER.find((d) => d > current);
  return next ?? null;
}

/** Frames the GPU may hold before submit() sheds new ones (1 = classic double
 * buffering: frame N renders while N-1 is read). */
export const PIPELINE_DEPTH = 2;
/** A frame still unsignaled this long after submit is read anyway (blocking):
 * progress even on a driver that never reports its fences. */
export const PIPELINE_STALL_MS = 250;

/**
 * Pipelined detection (D-177): the GPU work for frame N is queued and its
 * results are read back one camera frame LATER, from a pixel-pack buffer behind
 * a fence, so the main thread never waits for the GPU. The synchronous
 * {@link DetectorGL.detect} stalls on readPixels for the whole GPU frame (~10 ms
 * on a Pixel 10 Pro Fold, several times that on a mid-range GPU) — the bulk of
 * the 21-28 ms p95 that dropped a quarter of the frames at 60 fps.
 *
 * Per camera frame: `submit(frame, tag)` renders and starts the async readback;
 * `collect()` returns every frame whose fence has signaled, oldest first, as
 * detected blobs with the tag it was submitted with (the caller keeps the
 * frame's timestamp/pose/K in the tag — a result belongs to ITS frame, never
 * the one that was current when it came back). Nothing is reordered and
 * nothing is dropped once submitted. When the GPU is PIPELINE_DEPTH frames
 * behind, submit() returns false and does nothing: the frame is shed exactly
 * like one the camera dropped (the decoder and bit-rate negotiation already
 * handle those), and the main thread stays free instead of blocking.
 *
 * Results are identical to detect()'s: the same passes, the same buffer, the
 * same CCL. The adaptive detector's noise floor refreshes from the stats target
 * read back in the same slot (a frame or two staler than the synchronous path's,
 * at scene speed either way), and the scene-measure pass rides along on request.
 */
export class DetectPipeline<T> {
  private readonly slots: Slot<T>[] = [];
  private readonly freePbos: WebGLBuffer[] = [];
  private cpu = new Uint8Array(0);
  private statsCpu = new Float32Array(0);
  private measureCpu = new Uint8Array(0);
  /** Frames submit() refused because the GPU was behind. */
  shed = 0;
  /** Frames submit() queued. */
  submitted = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly det: DetectorGL,
    private readonly depth = PIPELINE_DEPTH,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Frames submitted and not yet collected. */
  get inFlight(): number {
    return this.slots.length;
  }

  /**
   * Queue one frame. Returns false (and queues nothing) when the GPU is already
   * `depth` frames behind and the oldest has not finished — shed this frame.
   */
  submit(f: DetectInput, tag: T, opts: { measure?: boolean } = {}): boolean {
    const gl = this.gl;
    const r = f.reduced;
    if (r) {
      // Pre-reduced (native) frame: no GPU work, ready on the next collect.
      this.slots.push({
        tag,
        tSubmit: this.now(),
        sync: null,
        pbo: null,
        w: r.w,
        h: r.h,
        imgH: f.imgH,
        ds: r.w > 0 ? f.imgW / r.w : this.det.downscale,
        flipV: false,
        stats: null,
        measure: null,
        reduced: r,
        ...(opts.measure ? { measureNow: this.det.measureFrame(f) } : {}),
      });
      this.submitted++;
      return true;
    }
    const pending = this.slots.filter((s) => s.sync !== null).length;
    if (pending >= this.depth && !this.ready(this.slots[0]!)) {
      this.shed++;
      return false;
    }
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const tex = f.texture!;
    const d = this.det.renderDetect(tex, f.imgW, f.imgH);
    const bytes = d.w * d.h * 4;
    const pbo = this.pbo(bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, d.w, d.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    let stats: Slot<T>["stats"] = null;
    if (d.stats !== null) {
      const sb = d.stats.w * d.stats.h * 16;
      const spbo = this.pbo(sb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, d.stats.fbo);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, spbo);
      gl.readPixels(0, 0, d.stats.w, d.stats.h, gl.RGBA, gl.FLOAT, 0);
      stats = { pbo: spbo, bytes: sb };
    }
    let measure: Slot<T>["measure"] = null;
    if (opts.measure) {
      const m = this.det.renderMeasure(tex, f.imgW, f.imgH);
      const mpbo = this.pbo(m.w * m.h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, mpbo);
      gl.readPixels(0, 0, m.w, m.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      measure = { pbo: mpbo, w: m.w, h: m.h };
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    this.slots.push({
      tag,
      tSubmit: this.now(),
      sync,
      pbo,
      w: d.w,
      h: d.h,
      imgH: f.imgH,
      ds: this.det.downscale,
      flipV: this.det.flipV,
      stats,
      measure,
      reduced: null,
    });
    this.submitted++;
    return true;
  }

  /** Every frame that is ready (fence signaled, or stalled past
   * PIPELINE_STALL_MS), oldest first. `all` = wait for everything in flight. */
  collect(all = false): DetectedFrame<T>[] {
    const out: DetectedFrame<T>[] = [];
    while (this.slots.length > 0) {
      const s = this.slots[0]!;
      if (!all && !this.ready(s) && this.now() - s.tSubmit < PIPELINE_STALL_MS) break;
      this.slots.shift();
      out.push(this.finish(s));
    }
    return out;
  }

  /** Free the GPU resources (pending frames are discarded). */
  dispose(): void {
    const gl = this.gl;
    for (const s of this.slots) {
      if (s.sync) gl.deleteSync(s.sync);
      for (const b of [s.pbo, s.stats?.pbo, s.measure?.pbo]) if (b) gl.deleteBuffer(b);
    }
    this.slots.length = 0;
    for (const b of this.freePbos) gl.deleteBuffer(b);
    this.freePbos.length = 0;
  }

  private ready(s: Slot<T>): boolean {
    if (s.sync === null) return true;
    const st = this.gl.clientWaitSync(s.sync, 0, 0);
    return st === this.gl.ALREADY_SIGNALED || st === this.gl.CONDITION_SATISFIED;
  }

  private finish(s: Slot<T>): DetectedFrame<T> {
    const gl = this.gl;
    const t0 = this.now();
    let buf: Uint8Array;
    let scene: SceneStats | undefined = s.measureNow;
    if (s.reduced !== null) {
      buf = s.reduced.detect;
    } else {
      const bytes = s.w * s.h * 4;
      if (this.cpu.length !== bytes) this.cpu = new Uint8Array(bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.cpu);
      buf = this.cpu;
      if (s.stats) {
        const n = s.stats.bytes / 4;
        if (this.statsCpu.length !== n) this.statsCpu = new Float32Array(n);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.stats.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.statsCpu);
        this.det.acceptStats(this.statsCpu);
      }
      if (s.measure) {
        const mb = s.measure.w * s.measure.h * 4;
        if (this.measureCpu.length !== mb) this.measureCpu = new Uint8Array(mb);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.measure.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.measureCpu);
        scene = this.det.acceptMeasure(this.measureCpu, s.measure.w, s.measure.h);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(s.sync!);
      for (const b of [s.pbo, s.stats?.pbo, s.measure?.pbo]) if (b) this.release(b);
    }
    const t1 = this.now();
    const blobs = this.det.blobsFromBuffer(buf, s.w, s.h, s.ds, s.imgH, s.flipV, {});
    const t2 = this.now();
    this.det.lastProfile = { submitMs: 0, readMs: t1 - t0, cclMs: t2 - t1, inFlight: this.slots.length };
    return { tag: s.tag, blobs, scene, latencyMs: t2 - s.tSubmit };
  }

  /** A pixel-pack buffer of at least `bytes` (recycled; sized to fit). */
  private pbo(bytes: number): WebGLBuffer {
    const gl = this.gl;
    const i = this.freePbos.findIndex((b) => (this.sizes.get(b) ?? 0) === bytes);
    const b = i >= 0 ? this.freePbos.splice(i, 1)[0]! : gl.createBuffer()!;
    if (this.sizes.get(b) !== bytes) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.sizes.set(b, bytes);
    }
    return b;
  }

  private readonly sizes = new Map<WebGLBuffer, number>();

  private release(b: WebGLBuffer): void {
    this.freePbos.push(b);
    // Bound the pool: a resolution change leaves old sizes behind.
    while (this.freePbos.length > 4 * (this.depth + 1)) {
      const old = this.freePbos.shift()!;
      this.sizes.delete(old);
      this.gl.deleteBuffer(old);
    }
  }
}

/** Width of the measure() readback target; height follows the image aspect. */
const MEASURE_W = 64;

/**
 * Luma statistics from the alpha channel of an unthresholded readback
 * (alpha = max-channel luminance when threshold is 0). Exported for tests —
 * the GL pass is device territory, the math is not.
 */
export function sceneStatsFromLuma(rgba: Uint8Array, pixels: number): SceneStats {
  // 256-bin histogram: exact percentiles without a sort.
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3]!;
    hist[a]!++;
    sum += a;
  }
  const p95Count = Math.ceil(pixels * 0.95);
  let acc = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= p95Count) {
      p95 = v;
      break;
    }
  }
  let clipped = 0;
  for (let v = 250; v < 256; v++) clipped += hist[v]!; // ≥ ~0.98
  return {
    meanLuma: sum / pixels / 255,
    p95Luma: p95 / 255,
    clipFrac: clipped / pixels,
  };
}

function buildProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}
