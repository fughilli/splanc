//! Minimal, bounded HTTP/1.1 for the AP-webserver role — request-line parse +
//! response builder, allocation-free. The request bytes are untrusted (remotely supplied)
//! (anyone associated to the AP can send them), so every access is bounds-checked
//! and an over-long request or response is refused, never written past its fixed
//! buffer. This is the same defensive posture as the 802.11/BLE parsers.

use crate::rx::{Buf, Overflow};

/// A parsed HTTP request line. Slices borrow the input buffer (no copy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request<'a> {
    pub method: &'a [u8],
    pub path: &'a [u8],
}

impl<'a> Request<'a> {
    /// Parse `METHOD SP PATH SP HTTP/1.x CRLF ...`. Returns `None` on anything
    /// malformed or truncated — bounded, never reads past `buf`.
    pub fn parse(buf: &'a [u8]) -> Option<Request<'a>> {
        let line_end = buf.windows(2).position(|w| w == b"\r\n")?;
        let line = &buf[..line_end];
        let sp1 = line.iter().position(|&b| b == b' ')?;
        let method = &line[..sp1];
        let rest = &line[sp1 + 1..];
        let sp2 = rest.iter().position(|&b| b == b' ')?;
        let path = &rest[..sp2];
        // require a version token after the second space
        let version = &rest[sp2 + 1..];
        if method.is_empty() || path.is_empty() || !version.starts_with(b"HTTP/") {
            return None;
        }
        Some(Request { method, path })
    }

    pub fn is_get(&self) -> bool {
        self.method == b"GET"
    }
}

/// Write a `usize` as decimal into `buf`, returning the number of bytes written.
/// `buf` must be at least 20 bytes (fits any u64).
fn write_dec(mut v: usize, buf: &mut [u8; 20]) -> usize {
    if v == 0 {
        buf[0] = b'0';
        return 1;
    }
    let mut tmp = [0u8; 20];
    let mut n = 0;
    while v > 0 {
        tmp[n] = b'0' + (v % 10) as u8;
        v /= 10;
        n += 1;
    }
    // emit the digits most-significant first
    for i in 0..n {
        buf[i] = tmp[n - 1 - i];
    }
    n
}

/// Build a bounded `200 OK` response with an HTML `body` into `out`. Returns
/// `Err(Overflow)` if the response would exceed `out`'s capacity — refused, not
/// truncated or overrun.
pub fn respond_200<const N: usize>(body: &[u8], out: &mut Buf<N>) -> Result<(), Overflow> {
    out.extend(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ")?;
    let mut num = [0u8; 20];
    let n = write_dec(body.len(), &mut num);
    out.extend(&num[..n])?;
    out.extend(b"\r\nConnection: close\r\n\r\n")?;
    out.extend(body)
}

/// Build a bounded `404 Not Found` response into `out`.
pub fn respond_404<const N: usize>(out: &mut Buf<N>) -> Result<(), Overflow> {
    out.extend(
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    )
}

/// A tiny fixed route table for the example webserver: `GET /` -> a static page,
/// anything else -> 404. All bounded; a hostile request never overruns `out`.
pub fn serve<const N: usize>(request: &[u8], out: &mut Buf<N>) -> Result<(), Overflow> {
    match Request::parse(request) {
        Some(req) if req.is_get() && (req.path == b"/" || req.path == b"/index.html") => {
            respond_200(b"<html><body><h1>heapless-c6</h1></body></html>", out)
        }
        _ => respond_404(out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_get_request_line() {
        let r = Request::parse(b"GET /index.html HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!(r.method, b"GET");
        assert_eq!(r.path, b"/index.html");
        assert!(r.is_get());
    }

    #[test]
    fn rejects_malformed() {
        assert!(Request::parse(b"nonsense").is_none());
        assert!(Request::parse(b"GET\r\n\r\n").is_none()); // no path/version
        assert!(Request::parse(b"GET / FTP/1.0\r\n").is_none()); // bad version
    }

    #[test]
    fn serve_root_is_200_and_bounded() {
        let mut out: Buf<256> = Buf::new();
        serve(b"GET / HTTP/1.1\r\n\r\n", &mut out).unwrap();
        assert!(out.as_slice().starts_with(b"HTTP/1.1 200 OK"));
        assert!(out.as_slice().ends_with(b"</html>"));
        // Content-Length header value must equal the actual body length.
        let s = out.as_slice();
        let body_start = s.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let body_len = s.len() - body_start;
        let cl = b"Content-Length: ";
        let i = s.windows(cl.len()).position(|w| w == cl).unwrap() + cl.len();
        let digits: usize = s[i..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .fold(0, |a, &b| a * 10 + (b - b'0') as usize);
        assert_eq!(digits, body_len);
    }

    #[test]
    fn unknown_path_is_404() {
        let mut out: Buf<128> = Buf::new();
        serve(b"GET /secret HTTP/1.1\r\n\r\n", &mut out).unwrap();
        assert!(out.as_slice().starts_with(b"HTTP/1.1 404"));
    }

    #[test]
    fn response_into_too_small_buffer_is_refused_not_overrun() {
        let mut tiny: Buf<8> = Buf::new();
        assert!(serve(b"GET / HTTP/1.1\r\n\r\n", &mut tiny).is_err());
    }
}
