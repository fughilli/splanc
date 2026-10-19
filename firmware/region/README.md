# firmware/region

Fixed-slot `Pool`, byte-class `Slab` and mode-union `ModeRegion`. Design and
integration plan: [docs/design/memory-regions.md](../../docs/design/memory-regions.md).

```sh
bazel test //firmware/region:all           # unit tests + doctests (incl. compile_fail)
bazel test //firmware/region:region_kani   # Kani proofs (#[cfg(kani)] in src/lib.rs)
bazel test //firmware/region:region_kani_slab   # just the ~1 s slab proof
```

The Kani targets are `manual` (not in `//...`): the first run fetches the
pinned Kani release bundle and its nightly rustc libs (~200 MB, hermetic, no
rustup or `cargo kani setup`). See //tools/kani and
[docs/design/kani-bazel.md](../../docs/design/kani-bazel.md).

The proofs (2026-10-19, kani-verifier 0.68.0: both verified,
`pool_bookkeeping` ~4 min, `slab_fits_and_routes` <1 s):

- `pool_bookkeeping`: any sequence of up to 6 alloc/free ops on a 4-slot pool;
  live slots never alias, alloc succeeds iff a slot is free, free + live == N,
  and min_free <= free.
- `slab_fits_and_routes`: a slab never returns a block smaller than the
  request, refuses only requests above the largest class, and a free routes back
  to the owning class.
