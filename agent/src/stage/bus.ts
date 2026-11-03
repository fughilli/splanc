/**
 * The stage's event bus: everything the TV shows, as server-sent events. Events
 * are kept (a bounded history) so a screen that connects or reloads mid-demo
 * catches up; twin frames are not kept, only the latest per player is sent.
 */

import type { ServerResponse } from "node:http";

export type StageEvent = { type: string } & Record<string, unknown>;

const HISTORY = 400;

export class StageBus {
  private history: (StageEvent & { seq: number })[] = [];
  private seq = 0;
  private clients = new Set<ServerResponse>();
  /** Extra events a new screen gets after the history (the twin's layouts). */
  snapshot: () => StageEvent[] = () => [];

  emit(ev: StageEvent): void {
    const e = { ...ev, seq: ++this.seq, at: Date.now() };
    this.history.push(e);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
    this.send(`event: stage\ndata: ${JSON.stringify(e)}\n\n`);
  }

  /** Clear the history (a new conversation); screens are told to clear too. */
  reset(): void {
    this.history = [];
    this.emit({ type: "reset" });
  }

  frame(player: string, rgb: string): void {
    if (this.clients.size === 0) return;
    this.send(`event: frame\ndata: ${JSON.stringify({ player, rgb })}\n\n`);
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": stage\n\n");
    for (const e of this.history) res.write(`event: stage\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of this.snapshot()) res.write(`event: stage\ndata: ${JSON.stringify(e)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    ping.unref?.();
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  get screens(): number {
    return this.clients.size;
  }

  events(): readonly StageEvent[] {
    return this.history;
  }

  private send(chunk: string): void {
    for (const c of this.clients) c.write(chunk);
  }
}
