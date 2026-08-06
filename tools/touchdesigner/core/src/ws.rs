//! A minimal RFC 6455 WebSocket *client* over a blocking `TcpStream` — just
//! enough to speak the player's binary protocol on `ws://<host>:81/ws`.
//!
//! A native plugin has none of a browser's mixed-content constraints, so we use
//! the firmware's plain-`ws` endpoint (port 81) and skip TLS entirely; the
//! `wss:443` path exists only for browsers. One protobuf message rides one
//! binary frame. Client→server frames are masked as the RFC requires.

use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct WsClient {
    stream: TcpStream,
    rng: u64,
}

impl WsClient {
    /// Open a TCP connection, perform the HTTP upgrade handshake for `path`
    /// (e.g. `/ws`) and return a ready client. `timeout` bounds both connect
    /// and every subsequent read/write.
    pub fn connect<A: ToSocketAddrs>(addr: A, host_header: &str, path: &str, timeout: Duration) -> io::Result<Self> {
        let sock = addr
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no address"))?;
        let stream = TcpStream::connect_timeout(&sock, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.set_nodelay(true).ok();
        // Seed a non-crypto RNG for the handshake key + frame masks.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9e3779b97f4a7c15)
            ^ (sock.port() as u64).wrapping_mul(0x100000001b3);
        let mut c = WsClient { stream, rng: seed | 1 };
        c.handshake(host_header, path)?;
        Ok(c)
    }

    // xorshift64* — enough randomness for a WS key / frame mask (not crypto).
    fn next_rand(&mut self) -> u64 {
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545f4914f6cdd1d)
    }

    fn handshake(&mut self, host: &str, path: &str) -> io::Result<()> {
        let mut key_bytes = [0u8; 16];
        for chunk in key_bytes.chunks_mut(8) {
            let r = self.next_rand().to_le_bytes();
            chunk.copy_from_slice(&r[..chunk.len()]);
        }
        let key = base64_encode(&key_bytes);
        let req = format!(
            "GET {path} HTTP/1.1\r\n\
             Host: {host}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        self.stream.write_all(req.as_bytes())?;
        self.stream.flush()?;

        // Read response headers up to the blank line.
        let mut buf = Vec::with_capacity(256);
        let mut byte = [0u8; 1];
        loop {
            let n = self.stream.read(&mut byte)?;
            if n == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "eof during handshake"));
            }
            buf.push(byte[0]);
            if buf.ends_with(b"\r\n\r\n") {
                break;
            }
            if buf.len() > 4096 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "handshake too large"));
            }
        }
        let head = String::from_utf8_lossy(&buf);
        let first = head.lines().next().unwrap_or("");
        if !first.contains("101") {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("ws upgrade failed: {first}"),
            ));
        }
        Ok(())
    }

    /// Send one binary message as a single masked frame.
    pub fn send_binary(&mut self, data: &[u8]) -> io::Result<()> {
        let mask = (self.next_rand() as u32).to_be_bytes();
        let mut frame = Vec::with_capacity(data.len() + 14);
        frame.push(0x82); // FIN | binary
        let len = data.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= 0xffff {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(data.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }

    /// Adjust the per-read timeout (bounds a subsequent [`Self::recv_message`]).
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.stream.set_read_timeout(timeout)
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.stream.read_exact(buf)
    }

    /// Read the next application (binary/text) message, transparently handling
    /// fragmentation and answering ping/close control frames. Returns the
    /// reassembled payload.
    pub fn recv_message(&mut self) -> io::Result<Vec<u8>> {
        let mut message = Vec::new();
        loop {
            let mut h2 = [0u8; 2];
            self.read_exact(&mut h2)?;
            let fin = h2[0] & 0x80 != 0;
            let opcode = h2[0] & 0x0f;
            let masked = h2[1] & 0x80 != 0;
            let mut len = (h2[1] & 0x7f) as u64;
            if len == 126 {
                let mut e = [0u8; 2];
                self.read_exact(&mut e)?;
                len = u16::from_be_bytes(e) as u64;
            } else if len == 127 {
                let mut e = [0u8; 8];
                self.read_exact(&mut e)?;
                len = u64::from_be_bytes(e);
            }
            let mut mask = [0u8; 4];
            if masked {
                self.read_exact(&mut mask)?;
            }
            let mut payload = vec![0u8; len as usize];
            self.read_exact(&mut payload)?;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i & 3];
                }
            }
            match opcode {
                0x0 | 0x1 | 0x2 => {
                    message.extend_from_slice(&payload);
                    if fin {
                        return Ok(message);
                    }
                }
                0x8 => {
                    return Err(io::Error::new(io::ErrorKind::ConnectionReset, "ws close"));
                }
                0x9 => {
                    // ping -> pong (echo payload)
                    self.send_control(0x8a, &payload)?;
                }
                0xa => { /* pong: ignore */ }
                _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "bad ws opcode")),
            }
        }
    }

    fn send_control(&mut self, b0: u8, payload: &[u8]) -> io::Result<()> {
        let mask = (self.next_rand() as u32).to_be_bytes();
        let mut frame = Vec::with_capacity(payload.len() + 6);
        frame.push(b0);
        frame.push(0x80 | payload.len() as u8); // control frames are <=125
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }
}

/// Standard base64 (with padding) — used only for the handshake key.
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn key_is_24_chars() {
        // A 16-byte key base64s to 24 chars (with one '=' pad).
        assert_eq!(base64_encode(&[0u8; 16]).len(), 24);
    }
}
