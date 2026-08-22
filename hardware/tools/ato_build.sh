#!/usr/bin/env bash
# Build an atopile PCB (//hardware/<board>) with rules_atopile's Nix-pinned
# `ato` + `kicad-cli`, WITHOUT wiring rules_atopile into //MODULE.bazel.
#
# rules_atopile was authored as a standalone ROOT Bazel module; its Nix
# toolchain uses rules_nixpkgs `nix_repo`/`nix_pkg` tags that are root-only and
# don't compose as a bazel_dep (they fail, then hit a rules_nixpkgs file-copy
# bug even when isolated). So instead of a fragile MODULE integration, this
# script fetches rules_atopile at a pinned commit, re-pins the aarch64-linux
# venvHash (the atopile uv-venv FOD drifts over time), and drives `ato` through
# its `nix develop` shell — exactly the flow the rules would run, hermetic once
# the Nix toolchain is realised.
#
# Usage:
#   hardware/tools/ato_build.sh <board-dir> [pcb|pdf|gerber]   (default: pcb)
# e.g.
#   hardware/tools/ato_build.sh hardware/splanc_dev
#   hardware/tools/ato_build.sh hardware/splanc_dev pdf
#
# Requires: nix + git on PATH (nix is already a repo system requirement).
set -euo pipefail

RA_COMMIT="16a7e0749ac542ca48fcaa4eb7133d60cf94f827"
RA_REMOTE="https://github.com/fughilli/rules_atopile.git"
# Under `bazel run` the script executes from runfiles, so prefer Bazel's
# workspace pointer; fall back to the script's own location for a direct run.
REPO_ROOT="${BUILD_WORKSPACE_DIRECTORY:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CACHE="${ATO_RULES_CACHE:-${HOME}/.cache/led_mapper/rules_atopile}"

BOARD_DIR="${1:?usage: ato_build.sh <board-dir> [pcb|pdf|gerber]}"
WHAT="${2:-pcb}"
BOARD_DIR="$(cd "${REPO_ROOT}/${BOARD_DIR#"${REPO_ROOT}/"}" 2>/dev/null || cd "${BOARD_DIR}"; pwd)"

# --- Fetch + pin rules_atopile ---------------------------------------------
if [ ! -d "${CACHE}/.git" ]; then
  echo ">> cloning rules_atopile @ ${RA_COMMIT:0:9} -> ${CACHE}"
  git clone --quiet "${RA_REMOTE}" "${CACHE}"
fi
git -C "${CACHE}" fetch --quiet origin "${RA_COMMIT}" 2>/dev/null || true
git -C "${CACHE}" checkout --quiet --force "${RA_COMMIT}"
git -C "${CACHE}" apply --quiet "${REPO_ROOT}/patches/rules_atopile-venvhash.patch" 2>/dev/null \
  || echo ">> venvHash patch already applied (or hash matches upstream)"

# --- Sanitize footprints (idempotent) --------------------------------------
# Works around an atopile 0.15.8 layout crash on EasyEDA footprints whose
# silkscreen is only circles (and strips zero-length lines). See the script.
python3 "${REPO_ROOT}/hardware/tools/sanitize_footprints.py" "${BOARD_DIR}/elec/src/parts" >/dev/null

# --- Build ------------------------------------------------------------------
run_ato() { nix develop "${CACHE}" --command bash -c "cd '${BOARD_DIR}' && $*"; }

case "${WHAT}" in
  pcb)
    echo ">> ato build (resolve + lay out -> .kicad_pcb)"
    run_ato "ATO_NON_INTERACTIVE=1 ato build"
    echo ">> board: ${BOARD_DIR}/elec/layout/default/default.kicad_pcb"
    ;;
  pdf)
    run_ato "ATO_NON_INTERACTIVE=1 ato build && \
      kicad-cli pcb export pdf -o build/default.pdf elec/layout/default/default.kicad_pcb"
    echo ">> pdf: ${BOARD_DIR}/build/default.pdf"
    ;;
  gerber)
    run_ato "ATO_NON_INTERACTIVE=1 ato build && \
      mkdir -p build/gerbers && \
      kicad-cli pcb export gerbers -o build/gerbers elec/layout/default/default.kicad_pcb && \
      kicad-cli pcb export drill -o build/gerbers/ elec/layout/default/default.kicad_pcb"
    echo ">> gerbers: ${BOARD_DIR}/build/gerbers/"
    ;;
  *)
    echo "unknown target '${WHAT}' (want: pcb|pdf|gerber)" >&2
    exit 2
    ;;
esac
