/**
 * The phone slot's proxy: the stage connects to the phone's ScreenStream page
 * itself and presents it to the stage page as http://localhost:<port>/, so the
 * browser never meets the phone's self-signed certificate (no "proceed anyway"
 * in the loop) and the page still has a secure context (localhost is one), which
 * ScreenStream's hardware video (WebCodecs) needs.
 *
 * - TLS: the certificate the phone presents first after pairing is pinned (its
 *   SHA-256 is shown on the stage, to compare with the one ScreenStream shows);
 *   a different one is refused until the phone is paired again.
 * - Every request and WebSocket upgrade is forwarded with Host and Origin set to
 *   the phone's own, so ScreenStream's same-origin checks pass, and the answers
 *   come back without the headers that stop a page being framed. Plain-http
 *   ScreenStream (the stock app) goes through the same way, minus TLS.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const CONNECT_TIMEOUT_MS = 6000;

export class PhoneProxy {
  private server: Server | null = null;
  private target: URL | null = null;
  private pin: string | null = null;
  port = 0;

  constructor(
    private readonly log: (msg: string) => void,
    /** Called when a phone certificate is pinned (SHA-256, colon hex). */
    private readonly onPin: (fingerprint: string) => void = () => undefined,
  ) {}

  /** The pinned certificate's SHA-256 (null: none yet, or plain http). */
  get fingerprint(): string | null {
    return this.pin;
  }

  /** Point the proxy at a phone page (null: nothing); a new pairing re-pins. */
  setTarget(url: string | null): void {
    this.target = url ? new URL(url) : null;
    this.pin = null;
  }

  async listen(port: number, host: string): Promise<number> {
    const server = createServer((req, res) => {
      this.forward(req, res).catch((e: unknown) => fail(res, e));
    });
    server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
      this.upgrade(req, client, head).catch(() => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    return this.port;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  /** A connection to the phone: TLS with the pinned certificate, or plain TCP. */
  private async upstream(t: URL): Promise<Socket> {
    const https = t.protocol === "https:";
    const port = Number(t.port || (https ? 443 : 80));
    const host = t.hostname.replace(/^\[|\]$/g, "");
    const sock = https
      ? tlsConnect({ host, port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] })
      : netConnect({ host, port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the phone didn't answer")), CONNECT_TIMEOUT_MS);
      sock.once(https ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve();
      });
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    }).catch((e: unknown) => {
      sock.destroy();
      throw e;
    });
    if (https) {
      const fp = (sock as ReturnType<typeof tlsConnect>).getPeerCertificate().fingerprint256;
      if (!fp) {
        sock.destroy();
        throw new Error("the phone sent no certificate");
      }
      if (this.pin === null && this.target === t) {
        this.pin = fp;
        this.log(`stage: phone certificate pinned (SHA-256 ${fp})`);
        this.onPin(fp);
      } else if (fp !== this.pin) {
        sock.destroy();
        throw new Error("the phone's certificate changed: pair the phone again");
      }
    }
    return sock;
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.target;
    if (!t) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("No phone paired.");
      return;
    }
    const sock = await this.upstream(t);
    const up = httpRequest({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: Object.fromEntries(requestHeaders(req.rawHeaders, t)),
      // No agent: Node then uses this connection (agent: false would make its own).
      createConnection: () => sock,
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, responseHeaders(r.rawHeaders, t, localOrigin(req, this.port)).flat());
      r.pipe(res);
      res.on("close", () => sock.destroy());
    });
    up.on("error", (e) => fail(res, e));
    req.pipe(up);
  }

  private async upgrade(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const t = this.target;
    if (!t) return void client.destroy();
    const sock = await this.upstream(t);
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [k, v] of requestHeaders(req.rawHeaders, t)) lines.push(`${k}: ${v}`);
    sock.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) sock.write(head);
    sock.pipe(client);
    client.pipe(sock);
    const end = () => {
      sock.destroy();
      client.destroy();
    };
    sock.on("error", end).on("close", end);
    client.on("error", end).on("close", end);
  }
}

/** The request as the phone should see it: its own Host and Origin, no Referer. */
export function requestHeaders(raw: string[], t: URL): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i]!;
    const lk = k.toLowerCase();
    if (lk === "host") out.push([k, t.host]);
    else if (lk === "origin") out.push([k, t.origin]);
    else if (lk === "referer") continue;
    else out.push([k, raw[i + 1]!]);
  }
  if (!out.some(([k]) => k.toLowerCase() === "host")) out.push(["Host", t.host]);
  return out;
}

/** The phone's answer as the stage page should see it: framable, no HSTS, and
 * redirects back to the phone pointed at the proxy instead. */
export function responseHeaders(raw: string[], t: URL, local: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i]!;
    let v = raw[i + 1]!;
    const lk = k.toLowerCase();
    if (lk === "x-frame-options" || lk === "strict-transport-security") continue;
    if (lk === "content-security-policy") {
      v = v
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors\b/i.test(d))
        .join("; ");
      if (!v) continue;
    }
    if (lk === "location") {
      // ScreenStream's http port redirects / to its https port: either is the phone.
      const at = /^https?:\/\/[^/]+/i.exec(v);
      if (at && new URL(at[0]).hostname === t.hostname) v = local + v.slice(at[0].length);
    }
    out.push([k, v]);
  }
  return out;
}

function localOrigin(req: IncomingMessage, port: number): string {
  return `http://${req.headers.host ?? `localhost:${port}`}`;
}

function fail(res: ServerResponse, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(`Can't reach the phone: ${msg}`);
}
