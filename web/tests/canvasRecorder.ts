/**
 * A recording CanvasRenderingContext2D stand-in for draw-level UI tests. Every
 * method call is logged with its arguments plus the fill style and font in
 * effect at that moment, so a test can assert WHAT a renderer drew (LED dot
 * radii, the viewport background, overlay labels, the DPR transform) rather
 * than merely that it drew. Property writes (fillStyle, font, lineWidth,
 * globalCompositeOperation, …) stick like on a real context.
 *
 *   const rec = recordCanvas(canvas);      // canvas.getContext("2d") → rec.ctx
 *   view.start();                          // the renderer draws into it
 *   rec.of("arc").map((c) => c.args[2]);   // radii of every arc drawn
 *
 * (The fake DOM's own getContext only records method names; this one is for
 * tests that need the arguments.)
 */

export interface CanvasCall {
  name: string;
  args: unknown[];
  /** `ctx.fillStyle` when the call was made (e.g. a fillRect's colour). */
  fillStyle: unknown;
  /** `ctx.font` when the call was made (e.g. a fillText's size). */
  font: unknown;
}

export interface CanvasRecorder {
  ctx: CanvasRenderingContext2D;
  calls: CanvasCall[];
  /** The recorded calls of one method (e.g. "arc"), oldest first. */
  of(name: string): CanvasCall[];
  /** Strings passed to fillText, in draw order. */
  texts(): string[];
  /** Forget everything recorded so far (property state is kept). */
  clear(): void;
}

export function canvasRecorder(): CanvasRecorder {
  const calls: CanvasCall[] = [];
  const state: Record<string, unknown> = { fillStyle: "#000000", font: "10px sans-serif" };
  const record = (name: string, args: unknown[]): void => {
    calls.push({ name, args, fillStyle: state["fillStyle"], font: state["font"] });
  };
  const ctx = new Proxy(state, {
    get(t, key) {
      if (typeof key !== "string") return undefined;
      if (key in t) return t[key];
      if (key === "createRadialGradient" || key === "createLinearGradient" || key === "createPattern") {
        return (...args: unknown[]) => {
          record(key, args);
          return { addColorStop: (...stop: unknown[]) => record("addColorStop", stop) };
        };
      }
      if (key === "measureText") return (s: string) => ({ width: String(s).length * 6 });
      if (key === "createImageData" || key === "getImageData") {
        return (...a: number[]) => {
          const w = a.length >= 4 ? a[2]! : a[0]!;
          const h = a.length >= 4 ? a[3]! : a[1]!;
          return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) };
        };
      }
      return (...args: unknown[]) => record(key, args);
    },
    set(t, key, value) {
      if (typeof key === "string") t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    calls,
    of: (name) => calls.filter((c) => c.name === name),
    texts: () => calls.filter((c) => c.name === "fillText").map((c) => String(c.args[0])),
    clear: () => void calls.splice(0, calls.length),
  };
}

/** Route `canvas.getContext("2d")` to a fresh recorder (shadowing the fake
 * DOM's own context on this one element) and return the recorder. */
export function recordCanvas(canvas: object): CanvasRecorder {
  const rec = canvasRecorder();
  Object.defineProperty(canvas, "getContext", {
    value: (kind: string) => (kind === "2d" ? rec.ctx : null),
    configurable: true,
    writable: true,
  });
  return rec;
}
