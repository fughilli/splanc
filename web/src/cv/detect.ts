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
in vec2 uv;
out vec4 outColor;
void main() {
  vec3 rgb = texture(cam, uv).rgb;
  // Max channel: robust for saturated white AND colored LEDs.
  float lum = max(rgb.r, max(rgb.g, rgb.b));
  float m = lum >= threshold ? 1.0 : 0.0;
  // rgb: per-pixel color for the CPU stage's per-blob chroma (hue-coded
  // fixtures); alpha: masked luminance, the CCL fill/weight channel.
  outColor = vec4(rgb * m, m * lum);
}`;

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

export class DetectorGL {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly fbo: WebGLFramebuffer;
  private readonly targetTex: WebGLTexture;
  private readonly uThreshold: WebGLUniformLocation;
  private readonly uCam: WebGLUniformLocation;
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

  readonly downscale: number;
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

    this.program = buildProgram(gl, VS, FS);
    this.uThreshold = gl.getUniformLocation(this.program, "threshold")!;
    this.uCam = gl.getUniformLocation(this.program, "cam")!;

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
   * Run detection on a camera texture of `imgW`×`imgH`. Returns blobs in
   * full-resolution pixels, origin top-left (§7.4) — the readback's GL
   * bottom-left rows are flipped here.
   */
  detect(texture: WebGLTexture, imgW: number, imgH: number, opts: { stats?: boolean } = {}): Blob[] {
    const gl = this.gl;
    const w = Math.max(1, Math.round(imgW / this.downscale));
    const h = Math.max(1, Math.round(imgH / this.downscale));
    this.ensureTarget(w, h);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform1f(this.uThreshold, this.threshold);
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

    if (this.readback.length !== w * h * 4) this.readback = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readback);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);

    // Fill/weight channel is alpha (masked luminance); RGB carries color.
    // splitOversized: a washed-out strip merges every halo into one giant
    // component that maxArea used to silently drop — taking every LED with
    // it (2026-07-12 capture screenshot: one 98k-px component spanned the
    // frame at threshold 0.6, beyond even the threshold servo's 0.9 cap).
    // The cut ladders re-threshold such components into per-core blobs.
    const comps = connectedComponents(this.readback, w, h, 4, 3, {
      minArea: this.minArea,
      maxArea: this.maxArea,
      maxBlobs: this.maxBlobs,
      colorBase: 0,
      stats: opts.stats === true,
      splitOversized: true,
    });

    // readPixels row 0 is the render target's bottom row, and the fragment
    // shader samples the camera texture identity-mapped — so buffer row 0
    // holds the camera texture's v=0 row. Whether that row is the image top
    // or bottom is what `flipV` encodes (see DetectorOptions.flipV).
    const ds = this.downscale;
    return comps
      .filter((c) => Math.max(c.w, c.h) <= this.maxAspect * Math.min(c.w, c.h))
      .map((c) => {
        const blob: Blob = {
          u: c.x * ds,
          v: this.flipV ? imgH - c.y * ds : c.y * ds,
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

  /**
   * Unthresholded scene-luminance statistics for exposure monitoring
   * (cv/exposure.ts): the same pass with threshold 0 into a tiny fixed
   * target, so the readback (~64×36 RGBA) costs a fraction of a detect().
   * Run every few frames, not per frame — scene stats move at AE speed.
   */
  measure(texture: WebGLTexture, imgW: number, imgH: number): SceneStats {
    const gl = this.gl;
    const w = MEASURE_W;
    const h = Math.max(1, Math.round((MEASURE_W * imgH) / imgW));
    this.ensureMeasureTarget(w, h);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.measureFbo!);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform1f(this.uThreshold, 0.0); // unthresholded: alpha = raw luminance
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

    if (this.measureBuf.length !== w * h * 4) this.measureBuf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.measureBuf);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);

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
