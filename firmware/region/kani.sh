#!/usr/bin/env bash
# Run the Kani proofs (#[cfg(kani)] in src/lib.rs) without putting a Cargo.toml
# in the Bazel tree: stage a throwaway cargo package whose [lib] points at the
# real source, then `cargo kani`. Needs kani-verifier on PATH:
#   cargo install --locked kani-verifier && cargo kani setup
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/src/lib.rs"
pkg="$(mktemp -d)"
trap 'rm -rf "$pkg"' EXIT
cat >"$pkg/Cargo.toml" <<EOF
[package]
name = "ledmapper_region"
version = "0.0.0"
edition = "2021"

[lib]
path = "$src"

[lints.rust]
unexpected_cfgs = { level = "allow", check-cfg = ['cfg(kani)'] }
EOF
cd "$pkg"
cargo kani "$@"
