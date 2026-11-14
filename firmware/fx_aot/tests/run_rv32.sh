#!/usr/bin/env bash
# Optional target-ABI differential test; needs rustc's riscv32imac target and
# qemu-riscv32. No downloads, firmware flashing, or hardware access.
set -euo pipefail
cd "$(dirname "$0")/../../.."
rustc_bin=${RUSTC:-rustc}
qemu_bin=${QEMU_RISCV32:-qemu-riscv32}
work=$(mktemp -d "${TMPDIR:-/tmp}/fx-aot-rv32.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/host" "$work/target"
for mode in host target; do
    out="$work/$mode"
    flags=(--edition=2021 -O)
    if [[ "$mode" == target ]]; then
        flags+=(--target riscv32imac-unknown-none-elf -C panic=abort)
    fi
    "$rustc_bin" "${flags[@]}" --crate-name ledmapper_fx_vm --crate-type rlib firmware/fx_vm/src/lib.rs --out-dir "$out"
    flags+=(-L dependency="$out" --extern ledmapper_fx_vm="$out/libledmapper_fx_vm.rlib")
    "$rustc_bin" "${flags[@]}" --crate-name ledmapper_fx_jit --crate-type rlib firmware/fx_jit/src/lib.rs --out-dir "$out"
    flags+=(--extern ledmapper_fx_jit="$out/libledmapper_fx_jit.rlib")
    if [[ "$mode" == host ]]; then
        "$rustc_bin" "${flags[@]}" --crate-name ledmapper_fx_aot --crate-type rlib --cfg 'feature="alloc"' firmware/fx_aot/src/lib.rs --out-dir "$out"
        "$rustc_bin" "${flags[@]}" firmware/fx_aot/tests/gen_rv32.rs --extern ledmapper_fx_aot="$out/libledmapper_fx_aot.rlib" -o "$out/generate"
        "$out/generate" > "$work/cases.rs"
    else
        "$rustc_bin" "${flags[@]}" --crate-name ledmapper_fx_aot_nostd --crate-type rlib firmware/fx_aot/src/lib.rs --out-dir "$out"
        FX_AOT_RV32_CASES="$work/cases.rs" "$rustc_bin" "${flags[@]}" firmware/fx_aot/tests/rv32_check.rs --extern ledmapper_fx_aot_nostd="$out/libledmapper_fx_aot_nostd.rlib" -o "$out/check"
        "$qemu_bin" "$out/check"
    fi
done
