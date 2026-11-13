"""Records a Splanc P4's wired Vive tracker over Wi-Fi into lhd's .rec.gz format (for
lh_replay --raw / lh_protocheck), and its console alongside.

    python3 tools/p4_wifi_rec.py <lamp ip> out.rec.gz [--seconds N] [--console out.log]

Subscribes to the lamp's console (any datagram to udp/9001; re-sent every 30 s) and asks
the tracker to record (OSC /lh/record on udp/9000, every 5 s; the lamp stops on its own 15 s
after the last). The recording arrives as binary batches on the console channel
(firmware/p4/tracker/tracker_service.cpp):
    "\\0LHD" | seq u32 | records
    'F' set u8 | rtn i16 | len u8 | us i64 | data     feature exchange (the handshake)
    'R' iface u8 | len u8 | us i64 | data             input report
    'D' count u32                                     records the lamp dropped (ring full)
Console text goes to --console (default: next to the recording, .log) with host time.
Ctrl-C (or --seconds) ends it. Lost batches (UDP) are counted from the sequence numbers.

Sending /lh/record makes this host the lamp's OSC peer until another sender (a demo)
sends again: the lamp's /lh/pose replies come here meanwhile, and are ignored.
"""

import argparse
import gzip
import tempfile
import socket
import struct
import sys
import time

IFACE = {0: "IMU", 1: "Lightcap", 2: "Buttons"}


def osc_message(addr, *floats):
    def pad(b):
        return b + b"\0" * (4 - len(b) % 4)

    tags = "," + "f" * len(floats)
    return pad(addr.encode() + b"\0") + pad(tags.encode() + b"\0") + b"".join(struct.pack(">f", f) for f in floats)


def parse_batch(b):
    """Records in one batch: ("F", set, rtn, us, data) / ("R", iface, us, data)."""
    out, off = [], 8
    while off < len(b):
        kind = b[off : off + 1]
        if kind == b"F":
            setf, rtn, n, us = struct.unpack_from("<BhBq", b, off + 1)
            data = b[off + 13 : off + 13 + n]
            out.append(("F", setf, rtn, us, data))
            off += 13 + n
        elif kind == b"R":
            iface, n, us = struct.unpack_from("<BBq", b, off + 1)
            data = b[off + 11 : off + 11 + n]
            out.append(("R", iface, us, data))
            off += 11 + n
        elif kind == b"D":
            (count,) = struct.unpack_from("<I", b, off + 1)
            out.append(("D", count))
            off += 5
        else:
            raise ValueError("bad record type %r at %d" % (kind, off))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("host")
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0: Ctrl-C)")
    ap.add_argument("--console", help="console text file (default: OUT with .log)")
    ap.add_argument("--name", default="T20", help="device name in the recording (wired: not WM*)")
    a = ap.parse_args()
    console_path = a.console or a.out.replace(".rec.gz", "") + ".log"

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)  # bursts must not overflow it
    s.bind(("", 0))
    s.settimeout(0.5)
    t_start = time.time()
    last_sub = last_rec = 0.0
    seq_next = None
    n = {"F": 0, "R": 0, "batches": 0, "lost": 0, "bad": 0, "dropped_on_lamp": 0}
    text = b""
    # The lamp repeats the feature exchanges every 10 s (UDP may lose some): one copy of
    # each, written first; the reports go to a temporary file until then.
    features = {}  # (us, set) -> (set, rtn, data)
    tmp = tempfile.TemporaryFile("w+t")
    t0 = None
    with open(console_path, "a", buffering=1) as con:
        try:
            while not a.seconds or time.time() - t_start < a.seconds:
                now = time.time()
                if now - last_sub > 30:
                    s.sendto(b"sub", (a.host, 9001))
                    last_sub = now
                if now - last_rec > 5:
                    s.sendto(osc_message("/lh/record", 1.0), (a.host, 9000))
                    last_rec = now
                try:
                    d, src = s.recvfrom(65535)
                except socket.timeout:
                    continue
                if src[1] == 9000:
                    continue  # the lamp's OSC out (/lh/pose) while we're its peer
                if d.startswith(b"\0LHD"):
                    (seq,) = struct.unpack_from("<I", d, 4)
                    if seq_next is not None and seq != seq_next:
                        n["lost"] += (seq - seq_next) & 0xFFFFFFFF
                    seq_next = (seq + 1) & 0xFFFFFFFF
                    n["batches"] += 1
                    try:
                        recs = parse_batch(d)
                    except (ValueError, struct.error):
                        n["bad"] += 1
                        continue
                    for r in recs:
                        if r[0] == "D":
                            n["dropped_on_lamp"] = r[1]
                        elif r[0] == "F":
                            _, setf, rtn, us, data = r
                            features.setdefault((us, setf), (setf, rtn, data))
                        else:
                            _, iface, us, data = r
                            t0 = us if t0 is None else t0
                            tmp.write(
                                f"{(us - t0) / 1e6:.6f} {a.name} HIDIN {IFACE.get(iface, iface)} {us - t0} {len(data)} {data.hex()}\n"
                            )
                            n["R"] += 1
                    continue
                text += d
                *lines, text = text.split(b"\n")
                stamp = time.strftime("%H:%M:%S") + ".%03d" % (int(time.time() * 1000) % 1000)
                for ln in lines:
                    con.write(stamp + " " + ln.decode("utf-8", "replace").rstrip("\r") + "\n")
        except KeyboardInterrupt:
            pass
    # Features first, at t=0 (they happened at the handshake, before the reports).
    with gzip.open(a.out, "wt", compresslevel=3) as out:
        for (us, _), (setf, rtn, data) in sorted(features.items()):
            out.write(f"0.000000 {a.name} HIDFEAT {'SET' if setf else 'GET'} 0 {rtn} {data.hex()}\n")
        n["F"] = len(features)
        tmp.seek(0)
        for line in tmp:
            out.write(line)
    print(
        f"{n['F']} feature exchanges, {n['R']} reports in {n['batches']} batches "
        f"({n['lost']} lost in transit, {n['bad']} unparsed, {n['dropped_on_lamp']} records dropped on the lamp) "
        f"-> {a.out}; console -> {console_path}"
    )
    return 0 if n["F"] and n["R"] else 1


if __name__ == "__main__":
    sys.exit(main())
