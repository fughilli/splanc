/**
 * Node transport for the web app's LedMapperClient (web/src/net/client.ts): a
 * `SocketFactory` over the `ws` package, plus an HTTPS GET for the discovery
 * manifest. The player serves /ws (and /.well-known/splanc.json) over TLS with a
 * SELF-SIGNED certificate, so verification against a CA is off; instead, when the
 * manifest (or the operator) supplies the certificate's SHA-256, every connection
 * pins it and refuses a mismatch.
 */

import { createHash } from "node:crypto";
import https from "node:https";
import type { TLSSocket } from "node:tls";

import WebSocket from "ws";

import type { SocketFactory, SocketLike } from "../../web/src/net/client";

export interface TlsPolicy {
  /** Expected SHA-256 of the server certificate (DER), hex, any case/colons. */
  pinSha256?: string;
}

function normFp(fp: string): string {
  return fp.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** SHA-256 (hex) of a TLS socket's peer certificate, or null if none. */
export function peerFingerprint(sock: TLSSocket): string | null {
  const cert = sock.getPeerCertificate(false);
  if (!cert || !cert.raw) return null;
  return createHash("sha256").update(cert.raw).digest("hex");
}

/** Throws when a pin is set and the socket's certificate doesn't match it. */
export function checkPin(sock: TLSSocket, tls: TlsPolicy): void {
  if (!tls.pinSha256) return;
  const got = peerFingerprint(sock);
  if (got !== normFp(tls.pinSha256)) {
    throw new Error(`TLS certificate pin mismatch (got ${got ?? "none"}, want ${normFp(tls.pinSha256)})`);
  }
}

/** A `SocketFactory` for LedMapperClient that opens `ws`/`wss` with the policy.
 * `hooks.onPeer` gets each connection's certificate SHA-256 (trust on first use:
 * the hub remembers it as the player's pin); `hooks.onError` the socket's error
 * (LedMapperClient only reports "connection failed"). */
export function nodeSocketFactory(
  tls: TlsPolicy = {},
  hooks: { onPeer?: (sha256: string) => void; onError?: (e: Error) => void } = {},
): SocketFactory {
  const { onPeer, onError } = hooks;
  return (url: string): SocketLike => {
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 15000 });
    const adapter: SocketLike = {
      get readyState() {
        return ws.readyState;
      },
      binaryType: "arraybuffer",
      send(data: string | Uint8Array) {
        ws.send(data);
      },
      close() {
        ws.close();
      },
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    ws.binaryType = "nodebuffer";
    ws.on("upgrade", (res) => {
      try {
        // Report the presented certificate BEFORE the pin check, so a mismatch can
        // still be judged (trust.ts: a factory reset, or the legacy shared cert).
        const fp = peerFingerprint(res.socket as TLSSocket);
        if (fp) onPeer?.(fp);
        checkPin(res.socket as TLSSocket, tls);
      } catch (e) {
        onError?.(e as Error);
        adapter.onerror?.(e);
        ws.terminate();
      }
    });
    ws.on("open", () => adapter.onopen?.());
    ws.on("close", () => adapter.onclose?.());
    ws.on("error", (e) => {
      onError?.(e);
      adapter.onerror?.(e);
    });
    ws.on("message", (data: Buffer) => adapter.onmessage?.({ data: new Uint8Array(data) }));
    return adapter;
  };
}

export interface HttpResult {
  status: number;
  body: string;
  /** SHA-256 of the server certificate this response came over. */
  fingerprint: string | null;
}

/** GET an https URL from the player (self-signed; pinned when the policy has a pin). */
export function httpsGet(url: string, tls: TlsPolicy = {}, timeoutMs = 8000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // agent: false — a fresh TLS connection per GET: no keep-alive socket holding the
    // player's single TLS slot, and no resumed session, so the certificate we fingerprint
    // is the one this handshake presented.
    const req = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs, agent: false }, (res) => {
      let fp: string | null = null;
      try {
        fp = peerFingerprint(res.socket as TLSSocket);
        checkPin(res.socket as TLSSocket, tls);
      } catch (e) {
        res.destroy();
        reject(e);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), fingerprint: fp }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
  });
}
