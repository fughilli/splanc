"""Local UDP<->TCP relay: a UDP socket on 0.0.0.0:<udp> whose datagrams go over the
ssh-forwarded TCP port (to rig_relay.py) and whose replies return to the last sender."""

import socket
import struct
import sys
import threading

udp_port, tcp_port = int(sys.argv[1]), int(sys.argv[2])
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(("0.0.0.0", udp_port))
t = socket.create_connection(("127.0.0.1", tcp_port))
peer = [None]


def back():
    b = b""
    while True:
        d = t.recv(4096)
        if not d:
            return
        b += d
        while len(b) >= 2 and len(b) >= 2 + struct.unpack(">H", b[:2])[0]:
            n = struct.unpack(">H", b[:2])[0]
            print("from rig", n, flush=True)
            if peer[0]:
                u.sendto(b[2 : 2 + n], peer[0])
            b = b[2 + n :]


threading.Thread(target=back, daemon=True).start()
print("local relay up", udp_port, "->", tcp_port, flush=True)
while True:
    d, a = u.recvfrom(2048)
    peer[0] = a
    print("to rig", len(d), a, flush=True)
    t.sendall(struct.pack(">H", len(d)) + d)
