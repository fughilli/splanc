/**
 * ESP-IDF partition table (the 0xC00 bytes at 0x8000) — just enough to tell the
 * legacy single-app layout from the OTA loader + app layout before flashing an OTA
 * bundle (docs/design/ota.md "Migration"), and to find where littlefs lives.
 * Pure (no serial), unit-tested in web/tests/partitionTable.test.ts.
 */

export const PARTITION_TABLE_OFFSET = 0x8000;
export const PARTITION_TABLE_LEN = 0xc00;

export interface PartitionEntry {
  label: string;
  type: number; // 0 app, 1 data
  subtype: number; // app: 0x00 factory, 0x10 ota_0; data: 0x82 spiffs, …
  offset: number;
  size: number;
}

/** Parse the 32-byte entries (magic 0xAA50) up to the MD5 / blank terminator. */
export function parsePartitionTable(b: Uint8Array): PartitionEntry[] {
  const out: PartitionEntry[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 0; o + 32 <= b.length; o += 32) {
    if (b[o] !== 0xaa || b[o + 1] !== 0x50) break; // 0xEBEB (MD5) or 0xFFFF ends it
    let end = o + 12;
    while (end < o + 28 && b[end] !== 0) end++;
    out.push({
      type: b[o + 2]!,
      subtype: b[o + 3]!,
      offset: dv.getUint32(o + 4, true),
      size: dv.getUint32(o + 8, true),
      label: new TextDecoder().decode(b.subarray(o + 12, end)),
    });
  }
  return out;
}

/** True when the board already has the OTA layout (a factory "loader" app). */
export function hasOtaLayout(entries: PartitionEntry[]): boolean {
  return entries.some((e) => e.type === 0 && e.subtype === 0x00 && e.label === "loader");
}

/** The littlefs ("spiffs"-labelled) data partition, if any. */
export function littlefsPartition(entries: PartitionEntry[]): PartitionEntry | undefined {
  return entries.find((e) => e.type === 1 && e.subtype === 0x82);
}

/** A formatted littlefs shows its superblock name in one of its first two blocks. */
export function hasLittlefsSuperblock(head: Uint8Array): boolean {
  const needle = [0x6c, 0x69, 0x74, 0x74, 0x6c, 0x65, 0x66, 0x73]; // "littlefs"
  outer: for (let i = 0; i + needle.length <= head.length; i++) {
    for (let j = 0; j < needle.length; j++) if (head[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
