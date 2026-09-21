# The effects compiler (`fx_compiler/`)

A single-pass Rust compiler from the GLSL-ish effects source language to compact
`.fxb` bytecode: recursive-descent parsing with precedence-climbing expression
codegen, type checking, and uniform-manifest emission. It compiles to both a
native CLI and to wasm for live in-browser compilation in the effects editor.

## Key files

- `fx_compiler/src/lib.rs` — the compiler library.
- `fx_compiler/bin/compile_main.rs` — the CLI entry point.
- `fx_compiler/bin/wasm_lib.rs` — the wasm binding used by the browser editor.

## Build & run

```sh
# Compile an effect to bytecode:
bazel run //fx_compiler:fx_compile -- path/to/effect.fx -o out.fxb

# The browser bundle (loaded by the effects editor):
bazel build //fx_compiler:fx_compiler_web
```

The language, the `.fxb` container format, the opcode set, and the VM that runs
the output are all documented in {doc}`../EFFECTS`. The design rationale — why a
single-pass compiler, how types and uniforms are handled — is in
{doc}`../docs/design/effects-compiler`, and the execution model it targets in
{doc}`../docs/design/effects-runtime`.
