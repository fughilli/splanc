"""Raw RFC6455 WebSocket upgrade probe — run ON the rig against the DUT.

  python3 ws_handshake.py <ip> <port>

Prints whether the DUT completes the handshake (101) or just accepts TCP and
goes silent (the e2e's "timed out during opening handshake" symptom).
"""
import socket
import sys

ip, port = sys.argv[1], int(sys.argv[2])
req = (
    "GET /ws HTTP/1.1\r\n"
    f"Host: {ip}:{port}\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    "Sec-WebSocket-Version: 13\r\n"
    "\r\n"
)
try:
    s = socket.create_connection((ip, port), timeout=6)
except Exception as e:
    print(f"TCP connect FAILED: {e}")
    sys.exit(1)
print("TCP connected; sending upgrade…")
s.settimeout(10)
s.sendall(req.encode())
# Read until the header terminator \r\n\r\n (what a real client waits for), or
# time out — the e2e's failure is precisely never seeing that terminator.
buf = b""
import time as _t

t0 = _t.time()
try:
    while b"\r\n\r\n" not in buf and _t.time() - t0 < 10:
        chunk = s.recv(2048)
        if not chunk:
            break
        buf += chunk
except socket.timeout:
    pass

want = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="  # base64(SHA1(key+magic)) for the sent key
has_term = b"\r\n\r\n" in buf
print(f"total bytes: {len(buf)}, complete headers: {has_term}")
print("---\n" + buf.decode("latin1", "replace") + "\n---")
if not has_term:
    print("HANDSHAKE TIMEOUT: never received full header block (matches the e2e symptom)")
elif want.encode() in buf:
    print("HANDSHAKE OK: Sec-WebSocket-Accept is correct")
else:
    print(f"HANDSHAKE BAD ACCEPT: expected {want!r} not found")
