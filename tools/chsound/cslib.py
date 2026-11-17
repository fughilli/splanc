"""Host-side client for the channel-sounding bench daemon (csd.py) + sample decoding.

from cslib import Bench
b = Bench()                      # connects to 127.0.0.1:7700 (an ssh -L tunnel to the rig)
r = b.run([{"dev": "A", "cmd": "info"}])
x = b.cap("B", 16000, 0)         # complex64 RX samples from DUT B (RF-positive orientation)
"""

from __future__ import annotations

import base64
import json
import socket

import numpy as np

FS = 80e6


def decode_words(raw: bytes) -> tuple[np.ndarray, np.ndarray]:
    """Dump-engine words -> (complex samples, gain index). Bits 9:0 and 19:10 are signed
    10-bit; (19:10) + j(9:0) is the RF-positive-frequency sample (see the research doc)."""
    w = np.frombuffer(raw, dtype="<u4")
    a = ((w & 0x3FF).astype(np.int32) ^ 0x200) - 0x200
    b = (((w >> 10) & 0x3FF).astype(np.int32) ^ 0x200) - 0x200
    g = ((w >> 20) & 0xFF).astype(np.int32)
    return (b + 1j * a).astype(np.complex64), g


def decode_words_raw(raw: bytes):
    w = np.frombuffer(raw, dtype="<u4")
    a = ((w & 0x3FF).astype(np.int32) ^ 0x200) - 0x200
    b = (((w >> 10) & 0x3FF).astype(np.int32) ^ 0x200) - 0x200
    return a, b, ((w >> 20) & 0xFF).astype(np.int32)


def b64_of(lines: list[str]) -> bytes | None:
    """The B64 payload in a reply, or None if absent or corrupted (USB drop)."""
    for ln in lines or []:
        if ln.startswith("B64 "):
            try:
                _, n, data = ln.split(" ", 2)
                raw = base64.b64decode(data)
            except Exception:  # noqa: BLE001
                return None
            return raw if len(raw) == int(n) else None
    return None


class Bench:
    def __init__(self, host="127.0.0.1", port=7700):
        self.sock = socket.create_connection((host, port), timeout=300)
        self.f = self.sock.makefile("rwb")

    def run(self, steps):
        self.f.write((json.dumps({"steps": steps}) + "\n").encode())
        self.f.flush()
        return json.loads(self.f.readline())["results"]

    def cmd(self, dev, c, timeout=10.0):
        return self.run([{"dev": dev, "cmd": c, "timeout": timeout}])[0].get("lines")

    def cap(self, dev, n=16000, div=0, raw=False):
        lines = self.cmd(dev, f"cap {n} {div} 1")
        data = b64_of(lines)
        meta = [ln for ln in lines if not ln.startswith("B64")]
        if data is None:
            raise RuntimeError(f"capture failed: {meta}")
        return (decode_words_raw(data) if raw else decode_words(data)[0]), meta

    def sdr(self, freq, rate=20e6, n=2_000_000, lna=16, vga=20, amp=0):
        r = self.run([{"sdr": dict(freq=freq, rate=rate, n=n, lna=lna, vga=vga, amp=amp)}])[0]
        raw = base64.b64decode(r["sdr_b64"])
        iq = np.frombuffer(raw, dtype=np.int8).astype(np.float32)
        return (iq[0::2] + 1j * iq[1::2]).astype(np.complex64), r.get("sdr_log", "")


def sdr_decode(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    iq = np.frombuffer(raw, dtype=np.int8).astype(np.float32)
    return (iq[0::2] + 1j * iq[1::2]).astype(np.complex64)


def psd(x, fs, nfft=4096):
    """Welch-ish averaged PSD in dB, fftshifted; returns (freqs, dB)."""
    n = len(x) // nfft
    if n == 0:
        nfft = len(x)
        n = 1
    seg = x[: n * nfft].reshape(n, nfft) * np.hanning(nfft)
    p = np.mean(np.abs(np.fft.fft(seg, axis=1)) ** 2, axis=0)
    f = np.fft.fftfreq(nfft, 1 / fs)
    i = np.argsort(f)
    return f[i], 10 * np.log10(p[i] + 1e-12)
