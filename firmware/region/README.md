# firmware/region

Fixed-slot `Pool`, byte-class `Slab` and mode-union `ModeRegion`. Design and
integration plan: [docs/design/memory-regions.md](../../docs/design/memory-regions.md).

```sh
bazel test //firmware/region:all        # unit tests + doctests (incl. compile_fail)
firmware/region/kani.sh                 # Kani proofs (#[cfg(kani)] in src/lib.rs)
```

Kani is not in the Bazel build (no BCR module). One-time setup:
`cargo install --locked kani-verifier && cargo kani setup` (works on
aarch64-linux; from a nix shell: `nix shell nixpkgs#rustup nixpkgs#gcc`, then
`rustup default stable`). `kani.sh` stages a throwaway cargo package whose
`[lib]` points at `src/lib.rs`, so no `Cargo.toml` lives in the tree.

The proofs (2026-10-19, kani-verifier 0.68.0: both verified,
`pool_bookkeeping` ~4 min, `slab_fits_and_routes` <1 s):

- `pool_bookkeeping`: any sequence of up to 6 alloc/free ops on a 4-slot pool;
  live slots never alias, alloc succeeds iff a slot is free, free + live == N,
  and min_free <= free.
- `slab_fits_and_routes`: a slab never returns a block smaller than the
  request, refuses only requests above the largest class, and a free routes back
  to the owning class.
