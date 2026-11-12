/**
 * The hue-code kernel, loaded: `//firmware/pattern` (the ONE implementation of
 * the LED colour code — the same Rust the players link) compiled to a few-KB
 * wasm module with a flat numeric C ABI (firmware/pattern/abi/kernel_abi.rs),
 * embedded in the bundle as base64 (./kernel_wasm.ts, generated + diff-tested by
 * `//web:code_kernel_wasm`). The typed wrappers the CV code imports are
 * ./gray.ts, ./fec.ts, ./stride.ts and ./timing.ts; nothing else should call
 * the raw exports.
 *
 * Startup: the module is compiled + instantiated SYNCHRONOUSLY at import where
 * the engine allows it (Node, Safari, workers — no fetch, no await, so tests and
 * the decoder can call the kernel immediately). A browser that refuses a
 * main-thread synchronous compile above its size cap (Chromium's historical
 * 4 KB limit) gets an async compile instead, which the page entries await via
 * {@link codeKernelReady} before anything renders or decodes (ui/app/main.ts,
 * wall/main.ts). Calling a wrapper before then throws, loudly.
 */

import { KERNEL_WASM_BASE64 } from "./kernel_wasm";

/** The raw exports (see kernel_abi.rs for the contract of each). */
export interface KernelExports {
  memory: WebAssembly.Memory;
  pk_code_offset(): number;
  pk_frame_all_on(): number;
  pk_frame_all_off(): number;
  pk_data_frame_offset(): number;
  pk_gray(i: number): number;
  pk_decode_gray(value: number): number;
  pk_data_bits(ledCount: number): number;
  pk_expected_bits(ledCount: number, secded: number): number;
  pk_data_frames(bits: number, symbols: number): number;
  pk_cycle_frames(ledCount: number, symbols: number, secded: number): number;
  pk_secded_parity_bits(k: number): number;
  pk_secded_total_bits(k: number): number;
  pk_secded_encode(data: number, k: number): number;
  pk_secded_decode(word: number, k: number): number;
  pk_codeword(ledId: number, ledCount: number, secded: number): number;
  pk_symbol_at(ledId: number, frame: number, ledCount: number, symbols: number, secded: number): number;
  pk_color_index(ledId: number, frameIndex: number, ledCount: number, symbols: number, secded: number): number;
  pk_symbol_color(symbols: number, value: number): number;
  pk_symbol_buf(): number;
  pk_decode_cycle(n: number, ledCount: number, bits: number, symbols: number, secded: number): number;
  pk_stride_phase_count(spacing: number): number;
  pk_stride_lit(led: number, phase: number, spacing: number, anchorDensity: number): number;
  pk_cycle_ms(cycleFrames: number, bitPeriodMs: number): number;
  pk_phase_ms(t: number, epoch: number, cycleFrames: number, bitPeriodMs: number): number;
  pk_frame_index_at(t: number, epoch: number, cycleFrames: number, bitPeriodMs: number): number;
  pk_cycle_index_at(t: number, epoch: number, cycleFrames: number, bitPeriodMs: number): number;
  pk_frame_fraction_at(t: number, epoch: number, cycleFrames: number, bitPeriodMs: number): number;
}

/** Packed-result flags of pk_decode_cycle / pk_secded_decode (kernel_abi.rs). */
export const FLAG_CORRECTED = 0x80000000;
export const FLAG_UNCORRECTABLE = 0x40000000;
export const FLAG_VALUE = 0x20000000;
export const VALUE_MASK = FLAG_VALUE - 1;
/** pk_decode_cycle: inconsistent code-book (word wider than its SEC-DED code). */
export const FLAG_MALFORMED = 0x10000000;
/** Capacity of the decode symbol buffer (kernel_abi.rs SYMBOL_BUF_LEN). */
export const SYMBOL_BUF_LEN = 64;

/** The embedded module's bytes (exported for the size budget test). */
export function kernelWasmBytes(): Uint8Array {
  const bin = atob(KERNEL_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let loaded: KernelExports | null = null;

function adopt(mod: WebAssembly.Module): void {
  loaded = new WebAssembly.Instance(mod, {}).exports as unknown as KernelExports;
}

try {
  adopt(new WebAssembly.Module(kernelWasmBytes() as BufferSource));
} catch {
  // Main-thread sync-compile cap: fall through to the async compile below.
}

/** Resolves once the kernel is callable (already resolved where sync compile worked). */
export const codeKernelReady: Promise<void> = loaded
  ? Promise.resolve()
  : WebAssembly.compile(kernelWasmBytes() as BufferSource).then(adopt);

/** The kernel's exports; throws if called before {@link codeKernelReady}. */
export function kernel(): KernelExports {
  if (loaded === null) {
    throw new Error("hue-code kernel not loaded yet: await codeKernelReady before decoding/rendering");
  }
  return loaded;
}
