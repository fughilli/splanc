/** A local editor tour: no navigation, hardware setup or changes to saved docks. */
import type { FxLayout } from "../../effects/editor/layout";
import { TourOverlay } from "./overlay";

export const EFFECTS_TOUR_STEPS = [
  { pane: "preview", title: "Preview", body: "Watch your effect on this real LED installation. Drag to orbit; scroll or pinch to zoom." },
  { pane: "uniforms", title: "Uniforms", body: "Tune colours, speed and other controls live, without editing code." },
  { pane: "chat", title: "AI chat", body: "Describe a change. The assistant edits the effect, compiles it and checks the preview." },
  { pane: "code", title: "Code", body: "Edit the effect directly. Changes compile automatically into the live preview." },
  { pane: "midi", title: "MIDI", body: "Connect knobs, faders and buttons to your effect’s controls." },
  { pane: "video", title: "Video", body: "Use a camera or video file as an input texture for your effect." },
  { pane: "diagnostics", title: "Device", body: "Check compile errors and send your effect to connected hardware. The demo needs no device." },
  { pane: "disasm", title: "Disassembly", body: "Inspect the compiled instructions. Done restores the starting workspace." },
] as const;

export function mountEffectsTour(layout: FxLayout): () => void {
  const chip = document.createElement("div");
  chip.className = "fx-demo-tour-chip";
  const start = document.createElement("button");
  start.type = "button";
  start.textContent = "Take the 10-second tour";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Dismiss tour invitation");
  dismiss.addEventListener("click", () => { chip.hidden = true; });
  chip.append(start, dismiss);
  document.body.appendChild(chip);
  let overlay: TourOverlay | undefined;
  let index = 0;
  let frame = 0;
  let disposed = false;
  const finish = (): void => {
    cancelAnimationFrame(frame);
    overlay?.destroy();
    overlay = undefined;
    layout.resetLayout();
    chip.hidden = false;
    start.focus({ preventScroll: true });
  };
  const show = (): void => {
    cancelAnimationFrame(frame);
    const step = EFFECTS_TOUR_STEPS[index]!;
    layout.revealPane(step.pane);
    frame = requestAnimationFrame(() => {
      if (disposed || !overlay) return;
      overlay.render({
        title: step.title, body: step.body, index: index + 1, total: EFFECTS_TOUR_STEPS.length,
        target: layout.root.querySelector<HTMLElement>(`.fxpane[data-pane="${step.pane}"]`),
        isFirst: index === 0, isLast: index === EFFECTS_TOUR_STEPS.length - 1,
        onBack: () => { if (index > 0) { index--; show(); } },
        onNext: () => { if (++index < EFFECTS_TOUR_STEPS.length) show(); else finish(); },
        onSkip: finish,
      });
    });
  };
  start.addEventListener("click", () => {
    if (overlay || disposed) return;
    chip.hidden = true;
    layout.resetLayout();
    index = 0;
    overlay = new TourOverlay();
    show();
  });
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    overlay?.destroy();
    chip.remove();
  };
}
