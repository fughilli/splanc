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
  float v = lum >= threshold ? lum : 0.0;
  outColor = vec4(v, v, v, 1.0);
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
   * Whether the camera texture's v=0 row is the image BOTTOM (GL-style) —
   * then blob v must be flipped to the §7.4 top-left origin. Camera-texture
   * row order is device/driver territory: confirm on-device (a wrong flip
   * shows up as huge reprojection residuals from M3, since poses and pixels
   * disagree about "up"). Toggleable from the capture page (`?flipv=`).
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

  readonly downscale: number;
  threshold: number;
  flipV: boolean;
  private readonly minArea: number;
  private readonly maxArea: number;
  private readonly maxBlobs: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    opts: DetectorOptions = {},
  ) {
    this.downscale = opts.downscale ?? 2;
    this.threshold = opts.threshold ?? 0.6;
    this.flipV = opts.flipV ?? false;
    this.minArea = opts.minArea ?? 2;
    this.maxArea = opts.maxArea ?? 4000;
    this.maxBlobs = opts.maxBlobs ?? 2048;

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
  detect(texture: WebGLTexture, imgW: number, imgH: number): Blob[] {
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

    const comps = connectedComponents(this.readback, w, h, 4, 0, {
      minArea: this.minArea,
      maxArea: this.maxArea,
      maxBlobs: this.maxBlobs,
    });

    // readPixels row 0 is the render target's bottom row, and the fragment
    // shader samples the camera texture identity-mapped — so buffer row 0
    // holds the camera texture's v=0 row. Whether that row is the image top
    // or bottom is what `flipV` encodes (see DetectorOptions.flipV).
    const ds = this.downscale;
    return comps.map((c) => ({
      u: c.x * ds,
      v: this.flipV ? imgH - c.y * ds : c.y * ds,
      intensity: c.intensity,
      area: c.area * ds * ds,
    }));
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
