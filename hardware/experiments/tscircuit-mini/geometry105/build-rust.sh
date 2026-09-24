#!/bin/sh
set -eu
: "${RUSTUP_HOME:=$PWD/output/geometry105/toolchain/rustup}"
export RUSTUP_HOME
mkdir -p output/geometry105/rust
output/geometry105/toolchain/cargo/bin/rustc --edition 2021 --crate-type cdylib -C opt-level=3 hardware/experiments/tscircuit-mini/geometry105/rust/search.rs -o output/geometry105/rust/libpnr_search.dylib
