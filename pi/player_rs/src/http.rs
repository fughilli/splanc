//! Plain HTTPS answers on the player's WSS port: everything that is not a
//! WebSocket upgrade.
//!
//! The phone app's self-signed-certificate trust flow (`certApprovalUrl` in
//! web/src/net/client.ts, `trustCert` in web/src/ui/screens/deviceSheet.ts)
//! opens `https://<player>/` as a top-level popup so the browser offers its
//! "proceed anyway" interstitial, then waits for the page to postMessage
//! `ledmapper-cert-ok`. The netstack firmware serves exactly that page
//! (netstack_transport.cpp); this is the same page for the Pi and host players,
//! which used to answer with an empty response (ERR_EMPTY_RESPONSE: the trust
//! popup dead-ended).
//!
//! `player_host --web-root DIR` additionally serves static files from DIR, which
//! is how the virtual LED wall (web/wall.html, `bazel run //pi/player_rs:wall`)
//! loads from the player's own origin: the wall then reaches the player's control
//! plane same-origin (`wss://<page host>/ws`) with the certificate the browser
//! already accepted for the page.
//!
//! Pure request -> response functions (unit-tested) plus [`Prefixed`], the stream
//! adapter that lets the WebSocket handshake re-read a request head that was
//! already consumed to route it.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// The longest request head we buffer before giving up on a connection.
pub const MAX_HEAD: usize = 16 * 1024;

/// The trust page. `%WALL%` is replaced by the wall link (or nothing).
const CERT_PAGE: &str = "<!doctype html><meta charset=utf-8>\
<meta name=viewport content='width=device-width,initial-scale=1'>\
<title>Splanc player</title>\
<body style='font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;padding:2rem;max-width:34rem'>\
<h2>Certificate accepted \u{2713}</h2>\
<p>You can close this and return to the Splanc app. To add this player there, \
choose <b>Add device \u{2192} Enter address</b> and enter:</p>\
<p><code id=a style='font-size:1.2rem;background:#222;padding:.3rem .6rem;border-radius:4px'></code></p>\
%WALL%\
<script>document.getElementById('a').textContent='wss://'+location.host;\
try{if(window.opener)window.opener.postMessage('ledmapper-cert-ok','*');}catch(e){}</script>";

const WALL_LINK: &str = "<p style='margin-top:2rem'><a style='color:#6cf' href='wall.html'>\
Open the virtual LED wall</a> (on the screen the phone films).</p>";

/// The parts of a request head the router needs.
#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    /// The path without its query string, still percent-encoded.
    pub path: String,
    pub websocket: bool,
    pub content_length: usize,
}

/// Length of the request head (through the blank line) once `buf` holds it all.
pub fn head_len(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Parse a complete request head. `None` for anything that isn't HTTP/1.x.
pub fn parse_head(head: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut req = lines.next()?.split(' ');
    let method = req.next()?.to_string();
    let target = req.next()?;
    if !req.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    let mut websocket = false;
    let mut content_length = 0;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        if name.eq_ignore_ascii_case("upgrade") {
            websocket |= value.split(',').any(|v| v.trim().eq_ignore_ascii_case("websocket"));
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().unwrap_or(0);
        }
    }
    Some(Head { method, path, websocket, content_length })
}

/// The Content-Type for a served file.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Map a request path onto a file under `root`. `None` for anything that could
/// escape it (`..`, absolute or drive components, a NUL, a backslash).
pub fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = percent_decode(url_path)?;
    if rel.contains('\0') || rel.contains('\\') {
        return None;
    }
    let mut out = root.to_path_buf();
    for c in Path::new(rel.trim_start_matches('/')).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn response(status: &str, ctype: &str, body: &[u8], head_only: bool) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    if !head_only {
        out.extend_from_slice(body);
    }
    out
}

/// The full response to a non-WebSocket request. `web_root` is the optional
/// static tree (`--web-root`); `/` is always the trust page.
pub fn respond(head: &Head, web_root: Option<&Path>) -> Vec<u8> {
    let head_only = head.method == "HEAD";
    let text = "text/plain; charset=utf-8";
    // The virtual wall publishes its grid layout here for the M2 server's result
    // overlay; a player has no such overlay, so the POST is accepted and dropped
    // (a 404 would only make the wall log an error each capture).
    if head.method == "POST" && head.path == "/truth" {
        return response("204 No Content", text, b"", true);
    }
    if head.method != "GET" && !head_only {
        return response("405 Method Not Allowed", text, b"GET only\n", head_only);
    }
    if head.path == "/" || head.path == "/index.html" {
        let wall = web_root.is_some_and(|r| r.join("wall.html").is_file());
        let page = CERT_PAGE.replace("%WALL%", if wall { WALL_LINK } else { "" });
        return response("200 OK", "text/html; charset=utf-8", page.as_bytes(), head_only);
    }
    let not_found = || response("404 Not Found", text, b"not found\n", head_only);
    let Some(root) = web_root else { return not_found() };
    let Some(mut file) = resolve(root, &head.path) else { return not_found() };
    if file.is_dir() {
        file.push("index.html");
    }
    match std::fs::read(&file) {
        Ok(body) => response("200 OK", content_type(&file), &body, head_only),
        Err(_) => not_found(),
    }
}

/// A stream that first replays `pre` (bytes already read off `inner`), then
/// reads `inner`; writes go straight through. Lets the WebSocket handshake see
/// the request head the router consumed.
pub struct Prefixed<S> {
    pre: Vec<u8>,
    pos: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(pre: Vec<u8>, inner: S) -> Self {
        Self { pre, pos: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.pos < self.pre.len() {
            let n = (self.pre.len() - self.pos).min(buf.remaining());
            let start = self.pos;
            buf.put_slice(&self.pre[start..start + n]);
            self.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> Head {
        parse_head(raw.as_bytes()).expect("parses")
    }

    fn body(resp: &[u8]) -> &[u8] {
        &resp[head_len(resp).unwrap()..]
    }

    fn status(resp: &[u8]) -> String {
        String::from_utf8_lossy(resp).lines().next().unwrap().to_string()
    }

    #[test]
    fn finds_the_end_of_the_head() {
        assert_eq!(head_len(b"GET / HTTP/1.1\r\nHost: x\r\n"), None);
        assert_eq!(head_len(b"GET / HTTP/1.1\r\n\r\nrest"), Some(18));
    }

    #[test]
    fn parses_a_websocket_upgrade() {
        let h = head(
            "GET /ws?x=1 HTTP/1.1\r\nHost: a:8443\r\nConnection: Upgrade\r\n\
             upgrade: WebSocket\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        assert_eq!(h.method, "GET");
        assert_eq!(h.path, "/ws");
        assert!(h.websocket);
    }

    #[test]
    fn a_plain_get_is_not_an_upgrade() {
        let h = head("GET /wall.html HTTP/1.1\r\nHost: a\r\nConnection: keep-alive\r\n\r\n");
        assert!(!h.websocket);
        assert_eq!(h.path, "/wall.html");
        let p = head("POST /truth HTTP/1.1\r\nContent-Length: 42\r\n\r\n");
        assert_eq!(p.content_length, 42);
        assert!(parse_head(b"\x16\x03\x01garbage\r\n\r\n").is_none());
        assert!(parse_head(b"GET / SPDY\r\n\r\n").is_none());
    }

    #[test]
    fn root_is_the_trust_page_that_answers_the_app_popup() {
        let r = respond(&head("GET / HTTP/1.1\r\n\r\n"), None);
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        let b = String::from_utf8_lossy(body(&r));
        assert!(b.contains("postMessage('ledmapper-cert-ok'"), "{b}");
        assert!(!b.contains("wall.html"), "no wall link without a web root");
        assert!(String::from_utf8_lossy(&r).contains("Cache-Control: no-store"));
    }

    fn tree(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("player_http_{}_{name}", std::process::id()));
        std::fs::create_dir_all(d.join("assets")).unwrap();
        std::fs::write(d.join("wall.html"), "<canvas id=wall>").unwrap();
        std::fs::write(d.join("assets/wall-1.js"), "export{}").unwrap();
        std::fs::write(d.join("assets/k.wasm"), b"\0asm").unwrap();
        d
    }

    #[test]
    fn serves_the_web_root() {
        let root = tree("serve");
        let r = respond(&head("GET / HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert!(String::from_utf8_lossy(body(&r)).contains("href='wall.html'"));

        let r = respond(&head("GET /wall.html?url=x HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert_eq!(body(&r), b"<canvas id=wall>");
        assert!(String::from_utf8_lossy(&r).contains("Content-Type: text/html"));

        let r = respond(&head("GET /assets/wall-1.js HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert!(String::from_utf8_lossy(&r).contains("Content-Type: text/javascript"));
        let r = respond(&head("GET /assets/k.wasm HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert!(String::from_utf8_lossy(&r).contains("Content-Type: application/wasm"));

        let r = respond(&head("HEAD /wall.html HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert!(body(&r).is_empty());
        assert!(String::from_utf8_lossy(&r).contains("Content-Length: 16"));

        let r = respond(&head("GET /nope.js HTTP/1.1\r\n\r\n"), Some(root.as_path()));
        assert_eq!(status(&r), "HTTP/1.1 404 Not Found");
        let r = respond(&head("GET /wall.html HTTP/1.1\r\n\r\n"), None);
        assert_eq!(status(&r), "HTTP/1.1 404 Not Found");
    }

    #[test]
    fn never_escapes_the_web_root() {
        let root = tree("escape");
        for p in ["/../etc/passwd", "/assets/../../x", "/%2e%2e/x", "/a%5cb", "/a%00b", "/%zz"] {
            assert!(resolve(&root, p).is_none(), "{p}");
            let r = respond(&head(&format!("GET {p} HTTP/1.1\r\n\r\n")), Some(root.as_path()));
            assert_eq!(status(&r), "HTTP/1.1 404 Not Found", "{p}");
        }
        assert_eq!(resolve(&root, "/assets/./wall-1.js"), Some(root.join("assets/wall-1.js")));
    }

    #[test]
    fn methods() {
        let r = respond(&head("POST /truth HTTP/1.1\r\n\r\n"), None);
        assert_eq!(status(&r), "HTTP/1.1 204 No Content");
        let r = respond(&head("DELETE / HTTP/1.1\r\n\r\n"), None);
        assert_eq!(status(&r), "HTTP/1.1 405 Method Not Allowed");
    }

    #[tokio::test]
    async fn prefixed_replays_then_reads_through() {
        use tokio::io::AsyncReadExt;
        let mut s = Prefixed::new(b"head".to_vec(), &b"-tail"[..]);
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert_eq!(out, "head-tail");
    }
}
