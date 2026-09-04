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
#   /docs/        the developer docs site   (//docs:build, when staged in)
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
  # Cloudflare Pages Function(s) — the /gh-asset CORS proxy for release firmware
  # downloads. Staged at the deploy root so `wrangler pages deploy` compiles them;
  # on GitHub Pages these are just inert static files (the client uses the absolute
  # Cloudflare URL). Absent in a bare local build → skipped.
  if [ -d web/functions ]; then mkdir -p "$out/functions" && cp -RL web/functions/. "$out/functions/"; fi
  mkdir -p "$out/solver" && cp -RL solver/solver_web/. "$out/solver/"
  mkdir -p "$out/pulse" && cp -RL firmware/pulse/pulse_web/. "$out/pulse/"
  mkdir -p "$out/fx-compiler" && cp -RL fx_compiler/fx_compiler_web/. "$out/fx-compiler/"
  mkdir -p "$out/fx-vm" && cp -RL firmware/fx_vm/fx_vm_web/. "$out/fx-vm/"
  # The generated static user guide (FUG-103), served at /user-guide/. Generated
  # from the in-app guide catalog and pinned fresh by //web:user_guide_freshness.
  # index.html + any dedicated flow sub-pages (effect-editor.html, …).
  mkdir -p "$out/user-guide" && cp -L docs/user-guide/*.html "$out/user-guide/"
  # Captured app screenshots the guide embeds (may be absent on a bare build).
  if [ -d docs/user-guide/img ]; then cp -RL docs/user-guide/img "$out/user-guide/img"; fi
  # Firmware image(s) for in-browser USB flashing (FUG-60), staged at /firmware/
  # (the webapp fetches /firmware/manifest.json) — the "This build (dev)" flash
  # source. The flash bundles are NOT built here; CI's firmware job builds them and
  # hands the tar paths in $LEDMAPPER_FLASHBUNDLE (vendor) and, optionally,
  # $LEDMAPPER_FLASHBUNDLE_NETSTACK. When both are absent (a plain dev/site build,
  # or a production app release that ships firmware via GitHub Releases instead) we
  # skip firmware and the app reports "no bundled firmware".
  if [[ -n "${LEDMAPPER_FLASHBUNDLE:-}" && -f "${LEDMAPPER_FLASHBUNDLE}" ]]; then
    local rev="${LEDMAPPER_FLASHBUNDLE_REV:-}"
    local commit="" fwver=""
    if [[ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
      [[ -z "$rev" ]] && rev="$(git -C "$BUILD_WORKSPACE_DIRECTORY" rev-parse --short HEAD 2>/dev/null || true)"
      commit="$(git -C "$BUILD_WORKSPACE_DIRECTORY" rev-parse HEAD 2>/dev/null || true)"
      # Same firmware-v* stamp status.sh uses, so the dev flash source names the
      # version it would write (a plain checkout without the tag → 0.0.0-dev).
      fwver="$(git -C "$BUILD_WORKSPACE_DIRECTORY" describe --tags --match 'firmware-v*' 2>/dev/null || true)"
      fwver="${fwver#firmware-v}"
      [[ -z "$fwver" ]] && fwver="0.0.0-dev"
    fi
    local -a images=(--image "esp32c6=${LEDMAPPER_FLASHBUNDLE}")
    if [[ -n "${LEDMAPPER_FLASHBUNDLE_NETSTACK:-}" && -f "${LEDMAPPER_FLASHBUNDLE_NETSTACK}" ]]; then
      images+=(--image "esp32c6_netstack=${LEDMAPPER_FLASHBUNDLE_NETSTACK}")
    fi
    tools/stage_firmware --out "$out/firmware" \
      ${rev:+--revision "$rev"} \
      ${commit:+--commit "$commit"} \
      ${fwver:+--fw-version "$fwver"} \
      "${images[@]}"
  fi
  # Developer documentation (Sphinx site) at /docs/, so the app's About >
  # Documentation tab can link to ./docs/ from every origin. Like the firmware
  # bundle above, it's built separately (`bazel run //docs:build`) and handed in
  # via $LEDMAPPER_DOCS_SITE (an absolute path to the built HTML tree); when it's
  # absent (a plain dev build) we skip it and the app's docs link 404s until a
  # full site build stages it. CI sets it in the build-site + deploy jobs.
  if [[ -n "${LEDMAPPER_DOCS_SITE:-}" && -d "${LEDMAPPER_DOCS_SITE}" ]]; then
    mkdir -p "$out/docs" && cp -RL "${LEDMAPPER_DOCS_SITE}/." "$out/docs/"
  fi
  # Bazel outputs arrive read-only; the staging copy is ours to prune.
  chmod -R u+w "$out"
  # Dev-only artifacts that have no business on a CDN.
  find "$out" \( -name '*.d.ts' -o -name '.empty' \) -delete
}
