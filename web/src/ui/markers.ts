/**
 * M8 — in-session detection feedback: draws detected blob positions as GL
 * points into the XR base layer so the user can see what the CV stage sees.
 *
 * The mapping from camera-image pixels to the XR viewport assumes the camera
 * image is aspect-fill-cropped to the screen (how handheld AR composits the
 * passthrough). It's feedback, not measurement — a few px of error is fine.
 */

import type { Blob } from "../cv/types";

/**
 * Camera-image px → view px under the aspect-fill crop handheld AR uses to
 * composit the passthrough (shared by the GL blob markers and the DOM label
 * overlay so both annotate the same on-screen spot).
 */
export function imageToView(
  u: number,
  v: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const scale = Math.max(viewW / imgW, viewH / imgH);
  return {
    x: (u - imgW / 2) * scale + viewW / 2,
    y: (v - imgH / 2) * scale + viewH / 2,
  };
}

const VS = `#version 300 es
layout(location = 0) in vec2 ndc;
uniform float pointSize;
void main() {
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = pointSize;
}`;

const FS = `#version 300 es
precision mediump float;
uniform vec4 color;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;   // round points
  outColor = color;
}`;

export class MarkerRenderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly uColor: WebGLUniformLocation;
  private readonly uSize: WebGLUniformLocation;
  private buf = new Float32Array(0);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = build(gl, VS, FS);
    this.uColor = gl.getUniformLocation(this.program, "color")!;
    this.uSize = gl.getUniformLocation(this.program, "pointSize")!;
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Draw into the CURRENTLY BOUND framebuffer (caller binds the XR layer and
   * sets the viewport).
   */
  draw(
    blobs: readonly Blob[],
    imgW: number,
    imgH: number,
    viewW: number,
    viewH: number,
    rgba: [number, number, number, number],
    pointSize = 14,
  ): void {
    if (blobs.length === 0 || viewW === 0 || viewH === 0) return;
    const gl = this.gl;

    if (this.buf.length < blobs.length * 2) this.buf = new Float32Array(blobs.length * 2);
    let n = 0;
    for (const b of blobs) {
      const { x: xs, y: ys } = imageToView(b.u, b.v, imgW, imgH, viewW, viewH);
      const nx = (xs / viewW) * 2 - 1;
      const ny = 1 - (ys / viewH) * 2; // v down -> NDC y up
      if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
      this.buf[n++] = nx;
      this.buf[n++] = ny;
    }
    if (n === 0) return;

    gl.useProgram(this.program);
    gl.uniform4f(this.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.uniform1f(this.uSize, pointSize);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.subarray(0, n), gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, n / 2);
    gl.bindVertexArray(null);
  }
}

function build(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`marker shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`marker link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
