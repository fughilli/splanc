import { compileScript, FxPreview, deriveLedTopology } from "../fx/preview";
import { sceneUniformValues } from "../effects/scene";
import { MapView } from "../ui/mapview";
import { unpackSample } from "../store/showcaseFormat";
import { SAMPLE } from "../store/showcaseMaxa";
import { MAXA_DEMO_SOURCE, MAXA_DEMO_SCENE } from "./maxaScene";

/** A shell-free scene sharing the editor's shader, topology and firmware VM. */
async function mount(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  let preview: FxPreview | undefined;
  let raf = 0;
  let disposed = false;
  try {
    const compiled = await compileScript(MAXA_DEMO_SOURCE);
    if (!compiled.ok) throw new Error(compiled.diagnostics.map(error => error.msg).join("; "));
    preview = await FxPreview.create(compiled.bytecode);
    const sample = unpackSample(SAMPLE);
    preview.setTopology(deriveLedTopology(sample.map, sample.topology));
    for (const uniform of sceneUniformValues(compiled.uniforms, MAXA_DEMO_SCENE.uniforms)) {
      preview.setUniform(uniform.slot, uniform.value);
    }
    const view = new MapView(canvas, sample.map).useThumbnailFraming();
    view.setMesh(sample.mesh);
    const positions = new Float32Array(sample.map.leds.flatMap(led => led.xyz));
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let inView = true;
    let time = 0;
    let frame = 0;
    let previous = performance.now();
    const draw = (dt: number): void => {
      preview!.tick(time, dt, frame++, sample.map.leds.length);
      view.setLedColors(preview!.shadeAll(positions));
      view.renderFrame();
    };
    const animate = (now: number): void => {
      raf = 0;
      if (disposed || document.hidden || !inView || reducedMotion.matches) return;
      const dt = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      time += dt;
      draw(dt);
      raf = requestAnimationFrame(animate);
    };
    const sync = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (disposed) return;
      previous = performance.now();
      if (!document.hidden && inView && !reducedMotion.matches) raf = requestAnimationFrame(animate);
      else if (reducedMotion.matches) view.renderFrame();
    };
    const resize = new ResizeObserver(() => view.renderFrame());
    resize.observe(canvas);
    const visibility = new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      sync();
    });
    visibility.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", sync);
    window.addEventListener("pagehide", () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      preview?.dispose();
    }, { once: true });
    draw(0);
    status.remove();
    if (window.parent !== window) window.parent.postMessage("splanc:scene-ready", window.location.origin);
    sync();
  } catch (error) {
    preview?.dispose();
    status.textContent = "The live scene could not load. Open the Maxa demo in Splanc to try it.";
    console.error("Maxa scene", error);
  }
}

void mount();
