/**
 * Minimal, self-contained WebM (Matroska/EBML) muxer for a SINGLE VP8/VP9 video
 * track — just enough to wrap the frames WebCodecs' VideoEncoder emits into a
 * looping .webm the browser can play in a <video> (FUG-80 effect preview tiles).
 *
 * We vendor this rather than add an npm dependency: the fleet worktree has no
 * network, so the pnpm lockfile can't be touched. It is deliberately tiny — one
 * track, whole-file-in-memory (thumbnails are small), SimpleBlocks only, no
 * seek/cues — and the byte layout is unit-tested (tests/webmMuxer.test.ts).
 *
 * Timestamps use the default TimecodeScale (1e6 ns = 1 ms). A single cluster
 * spans the whole clip; the int16 SimpleBlock relative timecode caps a cluster
 * at 32.767 s, so we roll to a new cluster before then (a 30 s clip fits in one).
 */

// EBML element IDs, emitted as their raw big-endian bytes (each already carries
// its length descriptor, so no extra encoding is needed).
const ID_EBML = 0x1a45dfa3;
const ID_EBML_VERSION = 0x4286;
const ID_EBML_READ_VERSION = 0x42f7;
const ID_EBML_MAX_ID_LENGTH = 0x42f2;
const ID_EBML_MAX_SIZE_LENGTH = 0x42f3;
const ID_DOCTYPE = 0x4282;
const ID_DOCTYPE_VERSION = 0x4287;
const ID_DOCTYPE_READ_VERSION = 0x4285;

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_MUXING_APP = 0x4d80;
const ID_WRITING_APP = 0x5741;
const ID_DURATION = 0x4489;

const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_UID = 0x73c5;
const ID_FLAG_LACING = 0x9c;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;

const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;

const TRACK_NUMBER = 1;
/** Roll to a new cluster before the int16 relative-timecode overflows (ms). */
const MAX_CLUSTER_SPAN_MS = 30_000;

/** One encoded frame handed to the muxer. */
export interface MuxFrame {
  /** Compressed VP8/VP9 frame payload. */
  data: Uint8Array;
  /** Presentation time in milliseconds from the start of the clip. */
  timestampMs: number;
  /** True for a keyframe (VideoEncoder chunk type === "key"). */
  key: boolean;
}

export type WebmCodec = "V_VP8" | "V_VP9";

/** Minimal big-endian byte count needed to hold an unsigned integer (>= 1). */
function uintBytes(value: number): number {
  let n = 1;
  let v = Math.floor(value / 256);
  while (v > 0) {
    n++;
    v = Math.floor(v / 256);
  }
  return n;
}

/** An EBML element ID as its raw bytes (the ID constants above are big-endian). */
function idBytes(id: number): number[] {
  const out: number[] = [];
  let v = id;
  do {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return out;
}

/**
 * EBML "vint" size field: the value with a leading length marker. `minLen` pads
 * to a fixed width (unused here but handy for fixed-size sizes). All-ones is the
 * reserved "unknown size" pattern, so we never emit a value that would collide.
 */
export function encodeSize(value: number, minLen = 0): number[] {
  let len = Math.max(minLen, 1);
  // Grow until the value fits in 7*len bits (reserving the all-ones sentinel).
  while (value >= 2 ** (7 * len) - 1 && len < 8) len++;
  const out: number[] = new Array(len).fill(0);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (len - 1); // length marker on the first byte
  return out;
}

function uintBE(value: number, len = uintBytes(value)): number[] {
  const out: number[] = new Array(len).fill(0);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

/** An element carrying raw byte content: id + size + data. */
function el(id: number, data: number[] | Uint8Array): number[] {
  const body = Array.from(data);
  return [...idBytes(id), ...encodeSize(body.length), ...body];
}

function elUint(id: number, value: number): number[] {
  return el(id, uintBE(value));
}

function elString(id: number, s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return el(id, bytes);
}

function elFloat64(id: number, value: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false); // big-endian
  return el(id, new Uint8Array(buf));
}

/** SimpleBlock: track vint + int16 BE relative timecode + flags + frame data. */
function simpleBlock(frame: MuxFrame, clusterBaseMs: number): number[] {
  const rel = Math.round(frame.timestampMs - clusterBaseMs);
  const hi = (rel >> 8) & 0xff;
  const lo = rel & 0xff;
  const flags = frame.key ? 0x80 : 0x00;
  const body = [...encodeSize(TRACK_NUMBER), hi, lo, flags, ...frame.data];
  return el(ID_SIMPLE_BLOCK, body);
}

function flatten(chunks: number[][]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface MuxOptions {
  width: number;
  height: number;
  codec: WebmCodec;
  frames: MuxFrame[];
  /** Nominal clip duration in ms (usually last timestamp + one frame). */
  durationMs: number;
}

/** Mux encoded VP8/VP9 frames into a complete in-memory .webm byte stream. */
export function muxWebm(opts: MuxOptions): Uint8Array {
  const header = el(ID_EBML, [
    ...elUint(ID_EBML_VERSION, 1),
    ...elUint(ID_EBML_READ_VERSION, 1),
    ...elUint(ID_EBML_MAX_ID_LENGTH, 4),
    ...elUint(ID_EBML_MAX_SIZE_LENGTH, 8),
    ...elString(ID_DOCTYPE, "webm"),
    ...elUint(ID_DOCTYPE_VERSION, 2),
    ...elUint(ID_DOCTYPE_READ_VERSION, 2),
  ]);

  const info = el(ID_INFO, [
    ...elUint(ID_TIMECODE_SCALE, 1_000_000), // 1 ms
    ...elString(ID_MUXING_APP, "splanc"),
    ...elString(ID_WRITING_APP, "splanc"),
    ...elFloat64(ID_DURATION, opts.durationMs),
  ]);

  const tracks = el(ID_TRACKS, [
    ...el(ID_TRACK_ENTRY, [
      ...elUint(ID_TRACK_NUMBER, TRACK_NUMBER),
      ...elUint(ID_TRACK_UID, TRACK_NUMBER),
      ...elUint(ID_FLAG_LACING, 0),
      ...elUint(ID_TRACK_TYPE, 1), // video
      ...elString(ID_CODEC_ID, opts.codec),
      ...el(ID_VIDEO, [
        ...elUint(ID_PIXEL_WIDTH, opts.width),
        ...elUint(ID_PIXEL_HEIGHT, opts.height),
      ]),
    ]),
  ]);

  // Partition frames into clusters bounded by MAX_CLUSTER_SPAN_MS so relative
  // timecodes stay within int16. Each cluster: Timecode + its SimpleBlocks.
  const clusters: number[] = [];
  let i = 0;
  while (i < opts.frames.length) {
    const baseMs = Math.round(opts.frames[i]!.timestampMs);
    const blocks: number[] = [...elUint(ID_TIMECODE, baseMs)];
    for (; i < opts.frames.length; i++) {
      const f = opts.frames[i]!;
      if (f.timestampMs - baseMs > MAX_CLUSTER_SPAN_MS) break;
      blocks.push(...simpleBlock(f, baseMs));
    }
    clusters.push(...el(ID_CLUSTER, blocks));
  }

  const segment = el(ID_SEGMENT, [...info, ...tracks, ...clusters]);
  return flatten([header, segment]);
}
