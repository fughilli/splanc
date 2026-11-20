#!/usr/bin/env bash
# Build rfctl.uf2 for the Pico 2 with a pinned pico-sdk (see CMakeLists.txt).
#   pi/hitl/meshbench/rfctl/pico/build.sh [build_dir]
# Needs cmake, arm-none-eabi-gcc and python3 on PATH (e.g. inside
# `nix shell nixpkgs#cmake nixpkgs#gcc-arm-embedded nixpkgs#python3`) and network
# access for the one-time SDK clone.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build="${1:-${TMPDIR:-/tmp}/rfctl-build}"
sdk="${PICO_SDK_PATH:-$build/pico-sdk}"
SDK_TAG=2.1.1
if [ ! -d "$sdk/src" ]; then
  git clone --depth 1 -b "$SDK_TAG" https://github.com/raspberrypi/pico-sdk "$sdk"
  git -C "$sdk" submodule update --init --depth 1 lib/tinyusb
fi
cmake -S "$here" -B "$build/out" -DPICO_SDK_PATH="$sdk" -DPICO_BOARD=pico2 >/dev/null
cmake --build "$build/out" -j"$(nproc)"
ls -l "$build/out/rfctl.uf2"
