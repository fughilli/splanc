# shellcheck shell=bash
# Single source of truth for the LED Mapper static-site publish layout.
#
# The site is the Vite bundle at the root plus the four wasm bundles the app
# loads at runtime, staged at the SAME paths the Pi M2 server serves them from
# (see web/serve.sh) so the identical bundle works from every origin:
#   /             the app (capture PWA + wall + effects pages)
#   /solver/      the VIO solver wasm      (//solver:solver_web)
#   /pulse/       the effects Sim wasm     (//firmware/pulse:pulse_web)
#   /fx-compiler/ the effect compiler wasm (//fx_compiler:fx_compiler_web)
#   /fx-vm/       the effect preview VM     (//firmware/fx_vm:fx_vm_web)
#
# Sourced by both deploy_cloudflare.sh (Cloudflare Pages) and stage_site.sh
# (GitHub Pages CI) so both publish a byte-identical tree. Both are `bazel run`
# binaries, which start in the runfiles main-workspace dir — so the data deps
# below are at these stable relative paths.

# stage_site <output-dir>: (re)create <output-dir> and populate it with the
# complete publish tree. Leaves it populated for the caller.
stage_site() {
  local out="$1"
  rm -rf "$out"
  mkdir -p "$out"
  cp -RL web/dist/. "$out"/
  mkdir -p "$out/solver" && cp -RL solver/solver_web/. "$out/solver/"
  mkdir -p "$out/pulse" && cp -RL firmware/pulse/pulse_web/. "$out/pulse/"
  mkdir -p "$out/fx-compiler" && cp -RL fx_compiler/fx_compiler_web/. "$out/fx-compiler/"
  mkdir -p "$out/fx-vm" && cp -RL firmware/fx_vm/fx_vm_web/. "$out/fx-vm/"
  # Bazel outputs arrive read-only; the staging copy is ours to prune.
  chmod -R u+w "$out"
  # Dev-only artifacts that have no business on a CDN.
  find "$out" \( -name '*.d.ts' -o -name '.empty' \) -delete
}
