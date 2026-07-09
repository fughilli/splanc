/**
 * M8 — 3D-composited solved-LED markers: renders the live map's solved LED
 * positions into the XR layer through the frame's real view/projection
 * matrices, so each marker overlaps the physical LED exactly (up to solve
 * error — which makes registration error VISIBLE, a live quality check).
 *
 * Drawn as confidence-colored rings with a faint core, so the blinking LED
 * underneath stays observable through its own marker.
 */

import type { LedEntry } from "@ledmapper/protocol";
import type { Mat4 } from "../geom/mat4";

const VS = `#version 300 es
layout(location = 0) in vec3 pos;
layout(location = 1) in float conf;
uniform mat4 mvp;
uniform float pointSize;
out float vConf;
void main() {
  gl_Position = mvp * vec4(pos, 1.0);
  gl_PointSize = pointSize;
  vConf = conf;
}`;

const FS = `#version 300 es
precision mediump float;
in float vConf;
uniform float alpha;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // Ring near the rim + faint core: frames the LED without occluding it.
  float ring = smoothstep(0.13, 0.17, r2) * (1.0 - smoothstep(0.21, 0.25, r2));
  float core = (1.0 - smoothstep(0.0, 0.08, r2)) * 0.35;
  float a = max(ring, core) * alpha;
  if (a <= 0.0) discard;
  // Confidence: red (low) -> green (high), matching the map preview.
  vec3 color = mix(vec3(1.0, 0.32, 0.22), vec3(0.25, 1.0, 0.5), vConf);
  outColor = vec4(color, a);
}`;

export class SolvedMarkerRenderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly uMvp: WebGLUniformLocation;
  private readonly uSize: WebGLUniformLocation;
  private readonly uAlpha: WebGLUniformLocation;
  private count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = build(gl, VS, FS);
    this.uMvp = gl.getUniformLocation(this.program, "mvp")!;
    this.uSize = gl.getUniformLocation(this.program, "pointSize")!;
    this.uAlpha = gl.getUniformLocation(this.program, "alpha")!;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
  }

  /** Upload the latest solved set (once per live-map update, not per frame). */
  setLeds(leds: readonly LedEntry[]): void {
    const gl = this.gl;
    const buf = new Float32Array(leds.length * 4);
    for (let i = 0; i < leds.length; i++) {
      const l = leds[i]!;
      buf[i * 4] = l.xyz[0];
      buf[i * 4 + 1] = l.xyz[1];
      buf[i * 4 + 2] = l.xyz[2];
      buf[i * 4 + 3] = l.confidence;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    this.count = leds.length;
  }

  /** Draw into the currently bound framebuffer (caller sets the viewport). */
  draw(mvp: Mat4, pointSizePx = 26, alpha = 0.9): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMvp, false, mvp as Float32Array);
    gl.uniform1f(this.uSize, pointSizePx);
    gl.uniform1f(this.uAlpha, alpha);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }
}

function build(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`solved-marker shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`solved-marker link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
