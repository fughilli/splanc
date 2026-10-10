import { compileScript, FxPreview, deriveLedTopology, type FxCompiled } from "../fx/preview";
import { sceneUniformValues } from "../effects/scene";
import { MapView } from "../ui/mapview";
import { SHOWCASE_SAMPLES } from "../store/showcaseData";
import { SHOWCASE_SCENES } from "./showcaseScenes";

/** Shell-free rotating gallery sharing the editor's effects and firmware VM. */
async function mount(): Promise<void> {
  const canvas = document.querySelector("canvas")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const previews: FxPreview[] = [];
  let raf = 0;
  let disposed = false;
  let cleanup = (): void => {};
  try {
    const compiledSources = new Map<string, FxCompiled>();
    for (const demo of SHOWCASE_SCENES) {
      let compiled = compiledSources.get(demo.source);
      if (!compiled) {
        compiled = await compileScript(demo.source);
        if (!compiled.ok) throw new Error(compiled.diagnostics.map(error => error.msg).join("; "));
        compiledSources.set(demo.source, compiled);
      }
      const preview = await FxPreview.create(compiled.bytecode);
      previews.push(preview);
      const sample = SHOWCASE_SAMPLES.find(sample => sample.map.mapId === demo.scene.mapId)!;
      preview.setTopology(deriveLedTopology(sample.map, sample.topology));
      for (const uniform of sceneUniformValues(compiled.uniforms, demo.scene.uniforms)) {
        preview.setUniform(uniform.slot, uniform.value);
      }
    }
    const samples = SHOWCASE_SCENES.map(demo => SHOWCASE_SAMPLES.find(sample => sample.map.mapId === demo.scene.mapId)!);
    const positions = samples.map(sample => new Float32Array(sample.map.leds.flatMap(led => led.xyz)));
    const view = new MapView(canvas, samples[0]!.map).useThumbnailFraming();
    // Conservative framing prevents the fixture's size from breathing while orbiting.
    view.fitTight = false;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let inView = true;
    let index = 0;
    let elapsed = 0;
    const clocks = samples.map(() => ({ time: 0, frame: 0 }));
    let previous = performance.now();
    let yawOffset = 0, pitchOffset = 0;
    let targetYaw = 0, targetPitch = 0;
    const notify = (): void => {
      const demo = SHOWCASE_SCENES[index]!;
      if (window.parent !== window) window.parent.postMessage({
        type: "splanc:scene-change", id: demo.id, label: demo.label, index,
      }, window.location.origin);
    };
    const select = (next: number): void => {
      index = next;
      elapsed = 0;
      const sample = samples[index]!;
      view.update(sample.map);
      view.setMesh(sample.mesh);
      notify();
    };
    const draw = (dt: number): void => {
      const sample = samples[index]!;
      const preview = previews[index]!;
      const clock = clocks[index]!;
      clock.time += dt;
      preview.tick(clock.time, dt, clock.frame++, sample.map.leds.length);
      view.setLedColors(preview.shadeAll(positions[index]!));
      const ease = 1 - Math.exp(-dt / 0.25);
      yawOffset += (targetYaw - yawOffset) * ease;
      pitchOffset += (targetPitch - pitchOffset) * ease;
      view.setOrbit(reducedMotion.matches ? 0 : clock.time * 0.12 + yawOffset,
        0.35 + (reducedMotion.matches ? 0 : pitchOffset));
      view.renderFrame();
      canvas.style.opacity = reducedMotion.matches ? "1"
        : String(Math.min(1, elapsed / 0.5, (12 - elapsed) / 0.5));
    };
    const animate = (now: number): void => {
      raf = 0;
      if (disposed || document.hidden || !inView || reducedMotion.matches) return;
      // Cap dense volumes at 30 fps while keeping shader and camera time in sync.
      if (now - previous >= 1000 / 30) {
        const dt = Math.min((now - previous) / 1000, 0.1);
        previous = now;
        elapsed += dt;
        if (elapsed >= 12) select((index + 1) % samples.length);
        draw(dt);
      }
      raf = requestAnimationFrame(animate);
    };
    const sync = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (disposed) return;
      previous = performance.now();
      if (!document.hidden && inView && !reducedMotion.matches) raf = requestAnimationFrame(animate);
      else if (reducedMotion.matches) draw(0);
    };
    const pointerMove = (event: PointerEvent): void => {
      if (event.pointerType !== "mouse") return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      targetYaw = ((event.clientX - rect.left) / rect.width - 0.5) * 0.4;
      targetPitch = (0.5 - (event.clientY - rect.top) / rect.height) * 0.24;
    };
    const pointerLeave = (): void => { targetYaw = targetPitch = 0; };
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; index?: unknown } | null;
      if (data?.type !== "splanc:select-scene" || !Number.isInteger(data.index)) return;
      const next = data.index as number;
      if (next < 0 || next >= samples.length) return;
      select(next);
      draw(0);
      sync();
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
    canvas.addEventListener("pointermove", pointerMove, { passive: true });
    canvas.addEventListener("pointerleave", pointerLeave);
    window.addEventListener("message", onMessage);
    window.addEventListener("pageshow", sync);
    cleanup = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerleave", pointerLeave);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pageshow", sync);
    };
    window.addEventListener("pagehide", event => {
      if (raf) cancelAnimationFrame(raf);
      if (event.persisted) return;
      cleanup();
      for (const preview of previews) preview.dispose();
    });
    select(0);
    draw(0);
    status.remove();
    if (window.parent !== window) window.parent.postMessage("splanc:scene-ready", window.location.origin);
    sync();
  } catch (error) {
    cleanup();
    for (const preview of previews) preview.dispose();
    status.textContent = "The live scenes could not load. Open Splanc to try the sample fixtures.";
    console.error("Showcase scenes", error);
  }
}

void mount();
