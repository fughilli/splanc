/**
 * OSC 1.0 encode/decode (a port of the desktop demo's osc.py), for the P4 demo page.
 *
 * The page sends OSC to the lamp inside the WebSocket session (ClientMessage.osc, the
 * player feeds it to its OSC input as if it came on udp/9000) and gets the P4 tracker
 * module's replies (/lh/pose ...) back as ServerMessage.osc. Only what the demo and the
 * firmware use: float32 `f`, int32 `i` and string `s` arguments, messages and
 * `#bundle`s (time tag "immediately").
 */

export type OscArg = number | string | { i: number };
export interface OscMessage {
  address: string;
  args: (number | string)[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A string's bytes, NUL-terminated and padded to a multiple of 4 (always at least
 * one NUL, as osc.py's `_pad`). */
function padStr(s: string): Uint8Array {
  const b = enc.encode(s);
  const out = new Uint8Array((Math.floor(b.length / 4) + 1) * 4);
  out.set(b);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One OSC message with float32 arguments (type tag ,f...), as osc.message. */
export function message(address: string, ...floats: number[]): Uint8Array {
  return messageTyped(address, ...floats);
}

/**
 * One OSC message with typed arguments, as osc.message_typed: a plain number is a
 * float32 (`f`), `{ i: n }` an int32 (`i`), a string an OSC string (`s`). E.g. the
 * P4's `/lh/station ,iffffff f`: `messageTyped("/lh/station", { i: id }, x, y, ...)`.
 */
export function messageTyped(address: string, ...args: OscArg[]): Uint8Array {
  let tags = ",";
  const body: Uint8Array[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      tags += "s";
      body.push(padStr(a));
    } else {
      const b = new Uint8Array(4);
      const dv = new DataView(b.buffer);
      if (typeof a === "number") {
        tags += "f";
        dv.setFloat32(0, a, false);
      } else {
        tags += "i";
        dv.setInt32(0, a.i | 0, false);
      }
      body.push(b);
    }
  }
  return concat([padStr(address), padStr(tags), ...body]);
}

/** A `#bundle` with the "immediately" time tag (1), as osc.bundle. */
export function bundle(...messages: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(16);
  head.set(enc.encode("#bundle"));
  new DataView(head.buffer).setUint32(12, 1, false); // time tag 0x0000000000000001
  const parts: Uint8Array[] = [head];
  for (const m of messages) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setInt32(0, m.length, false);
    parts.push(len, m);
  }
  return concat(parts);
}

function readStr(b: Uint8Array, i: number): [string, number] {
  let j = i;
  while (j < b.length && b[j] !== 0) j++;
  if (j >= b.length) throw new Error("OSC string not terminated");
  return [dec.decode(b.subarray(i, j)), (Math.floor(j / 4) + 1) * 4];
}

/** Datagram -> messages, flattening bundles (as osc.decode). Throws on a malformed
 * packet or an unsupported type tag. */
export function decode(packet: Uint8Array): OscMessage[] {
  const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (packet.length >= 8 && dec.decode(packet.subarray(0, 8)) === "#bundle\0") {
    const out: OscMessage[] = [];
    let i = 16;
    while (i + 4 <= packet.length) {
      const n = dv.getInt32(i, false);
      if (n < 0 || i + 4 + n > packet.length) throw new Error("OSC bundle element overruns");
      out.push(...decode(packet.subarray(i + 4, i + 4 + n)));
      i += 4 + n;
    }
    return out;
  }
  // readStr pads relative to the subarray's own start: a bundle element starts on a
  // 4-byte boundary of the packet, so offsets inside it stay aligned.
  const [address, i0] = readStr(packet, 0);
  if (i0 >= packet.length) return [{ address, args: [] }]; // no type tag string
  const [tags, i1] = readStr(packet, i0);
  if (!tags.startsWith(",")) throw new Error("OSC type tag string must start with ','");
  let i = i1;
  const args: (number | string)[] = [];
  for (const t of tags.slice(1)) {
    if (t === "f" || t === "i") {
      if (i + 4 > packet.length) throw new Error("OSC argument overruns");
      args.push(t === "f" ? dv.getFloat32(i, false) : dv.getInt32(i, false));
      i += 4;
    } else if (t === "s") {
      const [s, j] = readStr(packet, i);
      args.push(s);
      i = j;
    } else {
      throw new Error(`unsupported OSC type tag ${t}`);
    }
  }
  return [{ address, args }];
}

/** One decoded message as a log line, as osc.LogTransport writes them. */
export function describe(m: OscMessage): string {
  return `${m.address} ${m.args.map((a) => (typeof a === "number" ? +a.toPrecision(5) : a)).join(" ")}`.trim();
}
