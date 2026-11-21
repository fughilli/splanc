"""Rig-side UDP<->TCP relay (stdlib). Listens on 127.0.0.1:<tcp>; each TCP client
gets its own UDP socket to <dut>:<udp>. Frames on TCP are 2-byte BE length + datagram."""

import socket
import struct
import sys
import threading

dut, udp_port, tcp_port = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", tcp_port))
srv.listen(4)
print("relay up", dut, udp_port, tcp_port, flush=True)


def rx_exact(c, n):
    b = b""
    while len(b) < n:
        d = c.recv(n - len(b))
        if not d:
            raise EOFError
        b += d
    return b


stats = [0, 0]


def serve(c):
    print("tcp client", flush=True)
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def back():
        while True:
            d, a = u.recvfrom(2048)
            stats[1] += 1
            if stats[1] <= 20 or stats[1] % 50 == 0:
                print("from dut", a, stats, flush=True)
            try:
                c.sendall(struct.pack(">H", len(d)) + d)
            except OSError:
                return

    threading.Thread(target=back, daemon=True).start()
    try:
        while True:
            (n,) = struct.unpack(">H", rx_exact(c, 2))
            u.sendto(rx_exact(c, n), (dut, udp_port))
            stats[0] += 1
            if stats[0] <= 20 or stats[0] % 50 == 0:
                print("to dut", stats, flush=True)
    except (EOFError, OSError):
        pass
    c.close()
    u.close()


while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
