/**
 * Minimal reader for an uncompressed POSIX/ustar tar — just enough to unpack a
 * firmware flashbundle (a handful of small files, stored under their basenames by
 * tools/mk_flashbundle.py). Used by the GitHub-releases firmware source, which
 * fetches a release's `*.tar` asset and extracts flash.json + the image bins in
 * the browser (firmwareRepo.loadFlashRequestFromTar).
 *
 * Pure and DOM-free so it unit-tests under node. Returns a map of member basename
 * -> bytes; directory/other entries are skipped. Throws on a truncated/garbled
 * archive so a bad download surfaces as a clear flash error rather than silence.
 */

const BLOCK = 512;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Unpack an uncompressed tar into { basename -> bytes } for regular files. */
export function untar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    // A zeroed header block marks the end (the archive's two trailing zero blocks).
    if (header.every((b) => b === 0)) break;
    const name = dec
      .decode(header.subarray(0, 100))
      .replace(/\0.*$/, "")
      .trim();
    if (name === "") break;
    // Size is a NUL/space-padded octal string at offset 124 (12 bytes).
    const sizeStr = dec.decode(header.subarray(124, 136)).replace(/[^0-7]/g, "");
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size for "${name}"`);
    const dataStart = off + BLOCK;
    if (dataStart + size > buf.length) throw new Error(`tar: truncated member "${name}"`);
    const typeflag = header[156]; // 0x00 or '0' (0x30) = regular file
    if (typeflag === 0 || typeflag === 0x30) {
      out.set(basename(name), buf.subarray(dataStart, dataStart + size));
    }
    // Advance past the data, rounded up to the next 512-byte block boundary.
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
