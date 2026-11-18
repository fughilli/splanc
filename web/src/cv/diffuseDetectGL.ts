/**
 * WebGL2 port of the adaptive diffuse-spot detector (cv/diffuseDetect.ts is the
 * reference and the spec — keep the two numerically equivalent; the regression
 * suite web/tests/diffuseRope.test.ts runs the reference on real frames).
 *
 * Built for a mobile tiled GPU, where every full-resolution pass costs a full
 * write + re-read of its target: FIVE full-resolution passes, the rest at 1/16
 * of the pixels. At DETECTION resolution (camera / downscale), half-float targets:
 *   reduce     camera -> RAW  (LINEAR sample at the fragment centre = the 2x2 box
 *                              at downscale 2; rgb raw, a = max channel)
 *   gaussH     RAW -> T       (horizontal gaussian, the reference's gaussTaps)
 *   [quarter]  RAW -> Q -> BGQ (bgScale^2 box downsample, then 3 x (H,V) box
 *                              passes of radius bgBoxRadius at 1/bgScale)
 *   gaussV+dog T, BGQ -> SD   (rgb = spot colour, a = signed max channel of
 *                              spot - LINEAR-upsampled background; the response
 *                              also to a single-channel R16F second target)
 *   [stats]    SD.a sampled every statStride px -> tiny float target
 *   maxH       SD.resp -> M   (horizontal max of max(0, resp), R16F)
 *   maxV+final RAW, SD, M -> RGBA8 detect buffer (vertical max = the local peak,
 *                              then the keep test and encodePixel's encoding)
 * The final pass applies a RECENT frame's noise floor: every STATS_EVERY frames
 * the stats target is read back after the frame's own readback (already synced,
 * so it costs a copy, not a stall) and noiseFloor() — the reference's function —
 * sets the threshold until the next refresh. Only the first frame pays a
 * mid-frame sync. Borders are clamp-to-edge (texelFetch at
 * clamped coordinates, CLAMP_TO_EDGE for the bilinear upsample), like the
 * reference. Needs EXT_color_buffer_float (render to / read back half floats);
 * {@link AdaptiveDiffuseGL.supported} says whether this context has it.
 */

import { DEFAULT_ADAPTIVE_DIFFUSE, gaussTaps, noiseFloor, type AdaptiveDiffuseParams, type NoiseFloor } from "./diffuseDetect";

/** Frames between noise-floor refreshes (the statistic changes at scene speed). */
const STATS_EVERY = 4;

/** Most gaussian taps (one side, incl. centre) the shaders take. */
const MAX_TAPS = 16;

const VS = `#version 300 es
layout(location = 0) in vec2 pos;
void main() {
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D cam;
uniform vec2 size;
out vec4 o;
void main() {
  vec3 c = texture(cam, gl_FragCoord.xy / size).rgb;
  o = vec4(c, max(c.r, max(c.g, c.b)));
}`;

const GAUSS_H_FS = `#version 300 es
precision highp float;
uniform highp sampler2D src;
uniform float taps[${MAX_TAPS}];
uniform int radius;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s = taps[0] * texelFetch(src, p, 0).rgb;
  for (int i = 1; i <= radius; i++) {
    s += taps[i] * (texelFetch(src, ivec2(min(p.x + i, size.x - 1), p.y), 0).rgb +
                    texelFetch(src, ivec2(max(p.x - i, 0), p.y), 0).rgb);
  }
  o = vec4(s, 0.0);
}`;

const BOX_FS = `#version 300 es
precision highp float;
uniform highp sampler2D src;
uniform ivec2 dir;
uniform int radius;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  for (int i = -radius; i <= radius; i++) {
    s += texelFetch(src, clamp(p + dir * i, ivec2(0), size - 1), 0);
  }
  o = s / float(2 * radius + 1);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
uniform highp sampler2D src;
uniform int k;
out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 base = ivec2(gl_FragCoord.xy) * k;
  vec4 s = vec4(0.0);
  for (int j = 0; j < k; j++) {
    for (int i = 0; i < k; i++) s += texelFetch(src, min(base + ivec2(i, j), size - 1), 0);
  }
  o = s / float(k * k);
}`;

// Vertical gaussian (finishing the spot blur) + background subtraction.
const GAUSS_V_DOG_FS = `#version 300 es
precision highp float;
uniform highp sampler2D src;
uniform highp sampler2D bg;
uniform float taps[${MAX_TAPS}];
uniform int radius;
layout(location = 0) out vec4 o;
layout(location = 1) out float resp;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s = taps[0] * texelFetch(src, p, 0).rgb;
  for (int i = 1; i <= radius; i++) {
    s += taps[i] * (texelFetch(src, ivec2(p.x, min(p.y + i, size.y - 1)), 0).rgb +
                    texelFetch(src, ivec2(p.x, max(p.y - i, 0)), 0).rgb);
  }
  vec3 d = s - texture(bg, gl_FragCoord.xy / vec2(size)).rgb;
  float r = max(d.r, max(d.g, d.b));
  o = vec4(s, r);
  // The response alone, for the max filter: a single-channel target, so its
  // 2 x (2 peakRadius + 1) taps read a quarter of the bytes.
  resp = r;
}`;

const STATS_FS = `#version 300 es
precision highp float;
uniform highp sampler2D sd;
uniform int stride;
out vec4 o;
void main() {
  ivec2 size = textureSize(sd, 0);
  ivec2 p = min(ivec2(gl_FragCoord.xy) * stride, size - 1);
  o = vec4(texelFetch(sd, p, 0).a);
}`;

const MAX_H_FS = `#version 300 es
precision highp float;
uniform highp sampler2D resp;
uniform int radius;
out float o;
void main() {
  ivec2 size = textureSize(resp, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int i = -radius; i <= radius; i++) {
    m = max(m, texelFetch(resp, ivec2(clamp(p.x + i, 0, size.x - 1), p.y), 0).r);
  }
  o = m;
}`;

// Vertical max (completing the local peak) + the keep test + the output encoding.
const FINAL_FS = `#version 300 es
precision highp float;
uniform highp sampler2D raw;
uniform highp sampler2D sd;
uniform highp sampler2D mh;
uniform int radius;
uniform float floorT;
uniform float peakFrac;
out vec4 o;
void main() {
  ivec2 size = textureSize(sd, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 v = texelFetch(sd, p, 0);
  float r = max(0.0, v.a);
  if (r < floorT) { o = vec4(0.0); return; }
  float peak = 0.0;
  for (int i = -radius; i <= radius; i++) {
    peak = max(peak, texelFetch(mh, ivec2(p.x, clamp(p.y + i, 0, size.y - 1)), 0).r);
  }
  if (r < peakFrac * peak) { o = vec4(0.0); return; }
  float lum = clamp(texelFetch(raw, p, 0).a, 1.0 / 255.0, 1.0);
  vec3 c = max(v.rgb, vec3(0.0));
  float cmax = max(c.r, max(c.g, c.b));
  float k = cmax > 0.0 ? lum / cmax : 0.0;
  o = vec4(clamp(c * k, 0.0, 1.0), lum);
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  /** A second colour attachment (the SD pass's single-channel response). */
  tex2?: WebGLTexture;
}

type Prog = "reduce" | "gaussH" | "box" | "down" | "gaussVDog" | "stats" | "maxH" | "final";

export class AdaptiveDiffuseGL {
  /** Whether `gl` can run this detector (float render targets + float readback). */
  static supported(gl: WebGL2RenderingContext): boolean {
    return gl.getExtension("EXT_color_buffer_float") !== null;
  }

  private readonly vao: WebGLVertexArrayObject;
  private readonly progs: Record<Prog, WebGLProgram>;
  private readonly u = new Map<string, WebGLUniformLocation | null>();
  private readonly taps: Float32Array;
  private readonly tapRadius: number;
  private w = 0;
  private h = 0;
  private qw = 0;
  private qh = 0;
  private raw: Target | null = null;
  private t: Target | null = null;
  private sd: Target | null = null;
  private mh: Target | null = null;
  private q: Target | null = null;
  private qPing: Target | null = null;
  private qPong: Target | null = null;
  private bgq: Target | null = null;
  private stats: Target | null = null;
  private out: Target | null = null;
  private statsW = 0;
  private statsH = 0;
  private statsBuf = new Float32Array(0);
  private readback = new Uint8Array(0);
  /** The noise floor the last frame was thresholded with (diagnostics / trace). */
  lastNoise: NoiseFloor | null = null;
  /** The floor measured on the last frame — the next frame's threshold. */
  private nextNoise: NoiseFloor | null = null;
  private frame = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly params: AdaptiveDiffuseParams = DEFAULT_ADAPTIVE_DIFFUSE,
  ) {
    const taps = gaussTaps(params.spotSigma);
    if (taps.length > MAX_TAPS) throw new Error(`adaptive diffuse: spotSigma ${params.spotSigma} needs ${taps.length} taps (max ${MAX_TAPS})`);
    this.taps = new Float32Array(MAX_TAPS);
    this.taps.set(taps);
    this.tapRadius = taps.length - 1;
    this.progs = {
      reduce: build(gl, VS, REDUCE_FS),
      gaussH: build(gl, VS, GAUSS_H_FS),
      box: build(gl, VS, BOX_FS),
      down: build(gl, VS, DOWN_FS),
      gaussVDog: build(gl, VS, GAUSS_V_DOG_FS),
      stats: build(gl, VS, STATS_FS),
      maxH: build(gl, VS, MAX_H_FS),
      final: build(gl, VS, FINAL_FS),
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private loc(prog: Prog, name: string): WebGLUniformLocation | null {
    const key = `${prog}.${name}`;
    if (!this.u.has(key)) this.u.set(key, this.gl.getUniformLocation(this.progs[prog], name));
    return this.u.get(key)!;
  }

  /**
   * Run the detector on a camera texture; returns the RGBA8 detect buffer at
   * w x h (row 0 = the texture's v=0 row, as detect.ts's own readback).
   */
  run(camera: WebGLTexture, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const p = this.params;
    const r = this.tapRadius;
    this.ensure(w, h);
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    this.draw(this.raw!, w, h, "reduce", () => {
      this.bindTex(0, camera, "reduce", "cam", true);
      gl.uniform2f(this.loc("reduce", "size"), w, h);
    });
    this.draw(this.t!, w, h, "gaussH", () => {
      this.bindTex(0, this.raw!.tex, "gaussH", "src");
      gl.uniform1fv(this.loc("gaussH", "taps"), this.taps);
      gl.uniform1i(this.loc("gaussH", "radius"), r);
    });
    // Background at 1/bgScale: downsample, then 3 x (H,V) box passes.
    this.draw(this.q!, this.qw, this.qh, "down", () => {
      this.bindTex(0, this.raw!.tex, "down", "src");
      gl.uniform1i(this.loc("down", "k"), p.bgScale);
    });
    let from = this.q!;
    for (let pass = 0; pass < 3; pass++) {
      this.draw(this.qPing!, this.qw, this.qh, "box", () => {
        this.bindTex(0, from.tex, "box", "src");
        gl.uniform2i(this.loc("box", "dir"), 1, 0);
        gl.uniform1i(this.loc("box", "radius"), p.bgBoxRadius);
      });
      const to = pass === 2 ? this.bgq! : this.qPong!;
      this.draw(to, this.qw, this.qh, "box", () => {
        this.bindTex(0, this.qPing!.tex, "box", "src");
        gl.uniform2i(this.loc("box", "dir"), 0, 1);
        gl.uniform1i(this.loc("box", "radius"), p.bgBoxRadius);
      });
      from = to;
    }
    this.draw(this.sd!, w, h, "gaussVDog", () => {
      this.bindTex(0, this.t!.tex, "gaussVDog", "src");
      this.bindTex(1, this.bgq!.tex, "gaussVDog", "bg", true);
      gl.uniform1fv(this.loc("gaussVDog", "taps"), this.taps);
      gl.uniform1i(this.loc("gaussVDog", "radius"), r);
    });
    this.draw(this.stats!, this.statsW, this.statsH, "stats", () => {
      this.bindTex(0, this.sd!.tex, "stats", "sd");
      gl.uniform1i(this.loc("stats", "stride"), p.statStride);
    });
    // First frame (or after a resize): no previous floor — pay one mid-frame sync.
    if (this.nextNoise === null) this.nextNoise = this.readNoise();
    const noise = this.nextNoise;
    this.lastNoise = noise;
    this.draw(this.mh!, w, h, "maxH", () => {
      this.bindTex(0, this.sd!.tex2!, "maxH", "resp");
      gl.uniform1i(this.loc("maxH", "radius"), p.peakRadius);
    });
    this.draw(this.out!, w, h, "final", () => {
      this.bindTex(0, this.raw!.tex, "final", "raw");
      this.bindTex(1, this.sd!.tex, "final", "sd");
      this.bindTex(2, this.mh!.tex, "final", "mh");
      gl.uniform1i(this.loc("final", "radius"), p.peakRadius);
      gl.uniform1f(this.loc("final", "floorT"), noise.floor);
      gl.uniform1f(this.loc("final", "peakFrac"), p.peakFrac);
    });
    if (this.readback.length !== w * h * 4) this.readback = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readback);
    // The GPU has finished this frame (the readback synced it): the stats target
    // is ready, so reading it now costs a copy, not a stall. The floor moves at
    // scene speed, so refresh it every STATS_EVERY frames (~1.5 ms each time).
    if (++this.frame % STATS_EVERY === 0) this.nextNoise = this.readNoise();

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    return this.readback;
  }

  /** Read the stats target and turn it into a noise floor. */
  private readNoise(): NoiseFloor {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stats!.fbo);
    gl.readPixels(0, 0, this.statsW, this.statsH, gl.RGBA, gl.FLOAT, this.statsBuf);
    const sample = new Float32Array(this.statsW * this.statsH);
    for (let i = 0; i < sample.length; i++) sample[i] = this.statsBuf[i * 4]!;
    return noiseFloor(sample, this.params.kSigma);
  }

  private draw(t: Target, w: number, h: number, prog: Prog, setup: () => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progs[prog]);
    setup();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, tex: WebGLTexture, prog: Prog, uniform: string, linear = false): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (linear) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.uniform1i(this.loc(prog, uniform), unit);
  }

  private ensure(w: number, h: number): void {
    if (w === this.w && h === this.h && this.raw !== null) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    const tex = (tw: number, th: number, internal: number, format: number, type: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const fbo = (attach: WebGLTexture[]): WebGLFramebuffer => {
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      attach.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(attach.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`adaptive diffuse: framebuffer incomplete (0x${st.toString(16)})`);
      return f;
    };
    const mk = (tw: number, th: number, internal: number, type: number): Target => {
      const t = tex(tw, th, internal, gl.RGBA, type);
      return { tex: t, fbo: fbo([t]) };
    };
    for (const t of [this.raw, this.t, this.sd, this.mh, this.q, this.qPing, this.qPong, this.bgq, this.stats, this.out]) {
      if (t !== null) {
        gl.deleteTexture(t.tex);
        if (t.tex2) gl.deleteTexture(t.tex2);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    const half = (tw: number, th: number): Target => mk(tw, th, gl.RGBA16F, gl.HALF_FLOAT);
    this.raw = half(w, h);
    this.t = half(w, h);
    // SD: spot colour + response (RGBA16F) and the response alone (R16F), one pass.
    const sdTex = tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    const respTex = tex(w, h, gl.R16F, gl.RED, gl.HALF_FLOAT);
    this.sd = { tex: sdTex, tex2: respTex, fbo: fbo([sdTex, respTex]) };
    const mhTex = tex(w, h, gl.R16F, gl.RED, gl.HALF_FLOAT);
    this.mh = { tex: mhTex, fbo: fbo([mhTex]) };
    this.qw = Math.ceil(w / this.params.bgScale);
    this.qh = Math.ceil(h / this.params.bgScale);
    this.q = half(this.qw, this.qh);
    this.qPing = half(this.qw, this.qh);
    this.qPong = half(this.qw, this.qh);
    this.bgq = half(this.qw, this.qh);
    this.statsW = Math.ceil(w / this.params.statStride);
    this.statsH = Math.ceil(h / this.params.statStride);
    // Float32 so the stats readback is RGBA/FLOAT, the one float read format
    // EXT_color_buffer_float guarantees.
    this.stats = mk(this.statsW, this.statsH, gl.RGBA32F, gl.FLOAT);
    this.statsBuf = new Float32Array(this.statsW * this.statsH * 4);
    this.out = mk(w, h, gl.RGBA8, gl.UNSIGNED_BYTE);
    this.nextNoise = null;
  }
}

function build(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`adaptive diffuse shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`adaptive diffuse link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
