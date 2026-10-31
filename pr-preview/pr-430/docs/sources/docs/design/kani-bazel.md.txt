# Kani under Bazel

Status: working in-repo (2026-10-19). `//tools/kani` provides
`rust_kani_test`, which runs `//firmware/region`'s proofs and a dependency
fixture as hermetic `bazel test` targets. This doc explains why that didn't
exist, how it works, and what to contribute upstream.

```sh
bazel test //firmware/region:region_kani        # both region proofs (~5 min, CBMC)
bazel test //firmware/region:region_kani_slab   # the ~1 s slab proof
bazel test //tools/kani/tests:uses_clamp_kani   # harness reaching into a dep
```

All Kani targets are tagged `manual` + `kani`: the first run fetches about
200 MB.

## Why Kani didn't run under Bazel

Kani is not "another rustc", and nothing upstream bridged the gap.

1. **A rustc *driver* on a different compiler and sysroot.**
   `kani-compiler` links against one specific nightly's `librustc_driver`
   (0.68.0 uses nightly-2026-08-21).
   - It compiles against Kani's own sysroot: Kani-built `core`/`std` rlibs, the
     `kani` crate, and a `std` shim injected with
     `--extern noprelude,nounused:std=...`.
   - It also takes ~25 fixed `-Z`/`-C` flags (`-Z always-encode-mir`,
     `--cfg=kani`, `-C panic=abort`, `--kani-compiler`, harness options
     tunnelled through `-Cllvm-args`).
   - rules_rust's toolchain model is one rustc plus its matching std per
     target. The only driver swap it does, the clippy aspect, keeps the
     toolchain's sysroot and is built on private `//rust/private` APIs
     (`construct_arguments`, `collect_inputs`).
2. **Every dependency must be rebuilt.** A rules_rust rlib is built against the
   stable std, which has a different crate hash and metadata format, so
   kani-compiler can't link it.
   - `cargo kani` sets `RUSTC=kani-compiler` and rebuilds the whole graph with
     the Kani flags (`--emit=dep-info,metadata,link`).
   - Only the crate under test gets the harness options. Codegen of what a
     harness reaches in a dependency happens in that top crate, from the MIR
     the dependency's rmeta encodes.
   - So Bazel needs a parallel build graph: an aspect.
3. **The verify half lives only inside kani-driver, which insists on owning
   compilation.** After compiling, each harness runs a pipeline:
   - `goto-cc` links its symtab with `kani_lib.c` and sets the entry point;
   - three `goto-instrument` passes run;
   - `cbmc` runs with Kani's flags, and the driver parses the JSON verdict.

   Only `cargo kani` and standalone `kani <file>` drive this; neither verifies
   artifacts a build system produced. The open upstream
   [model-checking/kani#4600](https://github.com/model-checking/kani/pull/4600)
   (`kani verify-artifacts`, since 2026-05) exists to decouple them. Its own
   description cites the same build-system friction
   ([#4079](https://github.com/model-checking/kani/issues/4079),
   [#4212](https://github.com/model-checking/kani/issues/4212)).
4. **Distribution is rustup-shaped.** `cargo kani setup` installs into
   `~/.kani` plus a rustup toolchain. Kani does publish prebuilt bundles for
   {aarch64,x86_64}-{linux-gnu,apple-darwin} that already contain the Kani
   sysroot and CBMC. The only missing piece is the nightly `rustc` component's
   `lib/` (librustc_driver, libLLVM), which kani-compiler finds through its
   `$ORIGIN/../toolchain/lib` rpath.

**Prior art:**
- **No Bazel integration upstream.** There are no Kani issues or PRs in
  bazelbuild/rules_rust, no Bazel issues in model-checking/kani, and no
  `rules_kani`.
- **pulseengine/gale's `kani_test`** (`bzl/private/cargo.bzl`) shells out to
  the host's `cargo kani` with sandboxing off. That isn't hermetic, and gale's
  README notes it isn't in CI.
- **[pulseengine/rules_verus](https://github.com/pulseengine/rules_verus)** is
  the analogous hermetic pattern for another rustc-driver verifier (Verus).

## What //tools/kani does

- **`repositories.bzl` `kani_bundle`** (via `use_repo_rule`): downloads the
  sha-pinned Kani release bundle for the host and the matching nightly `rustc`
  component into `toolchain/`, which reproduces `cargo kani setup`'s layout.
  There is no rustup and no `~/.kani`.
- **`defs.bzl` `rust_kani_test(crate, harnesses)`:**
  - **Deps:** an aspect over `deps` rebuilds each dependency with kani-compiler
    (`--emit=metadata`, the same flags `cargo kani` logs under `--verbose`).
  - **Crate under test:** goes through Kani's standalone driver
    (`kani-driver <root>`), so the whole verify pipeline is Kani's own code.
    The test stages sources into `$TEST_TMPDIR`, because standalone mode
    writes goto artifacts beside the root file.
  - **Flags:** the edition and the deps' `--extern=name=<rmeta>` /
    `-Ldependency=` reach kani-compiler through `RUSTFLAGS`, which standalone
    mode forwards.
  - **Exit code:** kani-driver's exit status is the test verdict. An injected
    bug in a dependency (`//tools/kani/tests:clamp`) turns the test red.

**Quirks found:**
- Standalone mode splits `RUSTFLAGS` on single spaces, so an empty field
  becomes an empty input-file argument (`multiple input filenames provided`).
- Standalone mode names the crate after the file stem (`lib`).
- It has no output-directory option.

**Limitations:**
- No proc-macro deps or build scripts. They would need the nightly rustc plus
  its host `rust-std` to build host code the compiler can load.
- The crate's `crate_features`, `rustc_flags` and `rustc_env` aren't forwarded.
  Full fidelity needs rules_rust's private `construct_arguments`.
- One test re-verifies every harness when anything changes; there's no
  per-harness caching or sharding.

## Upstream proposal

**1. Kani (model-checking/kani): small, independent PRs.**
- **Support #4600 `kani verify-artifacts` to completion.** Maintainers want
  docs or an RFC (feliperodri). The open soundness review (rajath-mk) found
  that a verify step not passed `-Z loop-contracts` silently skips loop
  contracts the metadata records. The fix is to have the verify step take its
  options from the metadata, plus a version stamp. With that, a build system
  owns per-crate compilation, which is cacheable and remote-executable, and
  Kani owns only verification. That also answers #4212, where carolynzech
  calls cache invalidation "an unfixable limitation" under Cargo's
  fingerprinting.
- **`kani --print-compiler-args` (or a JSON file in the bundle):** the exact
  kani-compiler flags for this version, so build rules stop hardcoding
  `call_cargo.rs`'s list.
- **Standalone `--out-dir`**, and proper `RUSTFLAGS` tokenization, or a
  `KANI_ENCODED_RUSTFLAGS` with `\x1f` separators like Cargo's.

**2. Bazel side: a `rules_rust_kani` extension** in `bazelbuild/rules_rust`,
next to `extensions/{bindgen,prost,wasm_bindgen}` (this repo already uses
`rules_rust_wasm_bindgen`). Living in-repo lets it reuse
`construct_arguments` the way the clippy aspect does, which brings features,
cfgs, env, build-script outputs and proc-macros built with the bundle's
nightly. If the rules_rust maintainers decline, ship it as a standalone
`rules_kani` BCR module, modelled on rules_verus. Proposed API:
- `kani = use_extension("@rules_rust_kani//:extensions.bzl", "kani")`, then
  `kani.toolchain(version = "0.68.0")` (sha table per platform, like
  rules_rust's own).
- `rust_kani_test(crate, harnesses = [], unwind = None, kani_flags = [])`.
- A dep aspect: a `KaniCompile` action per crate, emitting rmetas. Once #4600
  lands, add a root `KaniCodegen` action emitting goto artifacts plus metadata,
  and the test runs `kani verify-artifacts`.
- **Map Bazel test sharding to harnesses:** `TEST_TOTAL_SHARDS` and
  `TEST_SHARD_INDEX` select a harness subset, so long proofs parallelize across
  executors.

**Order:** the Kani PRs first, since they are small and unblock a clean rule.
Then propose the rules_rust extension with this repo's `//tools/kani` as the
working reference. Nothing has been filed upstream yet.
