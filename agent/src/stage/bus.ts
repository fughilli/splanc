/**
 * The stage's event bus: everything the TV shows, as server-sent events. Events
 * are kept (a bounded history) so a screen that connects or reloads mid-demo
 * catches up; twin frames are not kept, only the latest per player is sent.
 *
 * Catch-up is a rebuild, never an append: every attach (a first load, a reload,
 * or EventSource reconnecting on its own) starts with a `sync` event, on which
 * the page clears what it shows, then replays the history and the snapshot, then
 * `live`. Replaying onto what a screen already showed is what duplicated the tool
 * cards (#449).
 *
 * The history is compacted as it is kept, so it holds whole turns rather than
 * the last few hundred streaming deltas: consecutive `say` / `thinking` deltas
 * merge into one event, and a streaming `code`, `tool_progress` or `request`
 * update replaces the previous one for the same id. Trimming drops whole turns
 * from the front, and never the current turn's `prompt`: losing it is what left
 * a reloaded screen with code and fixtures but a blank conversation (#445).
 */

import type { ServerResponse } from "node:http";

export type StageEvent = { type: string } & Record<string, unknown>;

type Kept = StageEvent & { seq: number };

export const HISTORY = 400;

/** Updates that replace the previous event of the same type and id. */
const REPLACES = new Set(["code", "tool_progress", "request"]);
/** Streaming text that merges with the event before it of the same type. */
const MERGES = new Set(["say", "thinking"]);
/** How much merged thinking is kept (the page shows the last ~220 characters). */
const THINKING_KEPT = 600;

export class StageBus {
  private history: Kept[] = [];
  private seq = 0;
  private clients = new Set<ServerResponse>();
  /** Extra events a new screen gets after the history (the twin's layouts). */
  snapshot: () => StageEvent[] = () => [];

  emit(ev: StageEvent): void {
    const e = { ...ev, seq: ++this.seq, at: Date.now() };
    this.keep(e);
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
    // All of this is written synchronously, before the screen joins the live
    // clients: no live event can interleave with (or repeat) the catch-up.
    res.write(`event: sync\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
    for (const e of this.history) res.write(`event: stage\ndata: ${JSON.stringify(e)}\n\n`);
    for (const e of this.snapshot()) res.write(`event: stage\ndata: ${JSON.stringify(e)}\n\n`);
    // Everything before this was catch-up: the screen draws it but doesn't speak it.
    res.write("event: live\ndata: {}\n\n");
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

  /** The kept (compacted) history: what a screen that connects now replays. */
  events(): readonly StageEvent[] {
    return this.history;
  }

  private keep(e: Kept): void {
    const h = this.history;
    const last = h[h.length - 1];
    if (MERGES.has(e.type) && last?.type === e.type) {
      let text = String(last["text"] ?? "") + String(e["text"] ?? "");
      if (e.type === "thinking" && text.length > THINKING_KEPT) text = text.slice(-THINKING_KEPT);
      h[h.length - 1] = { ...last, text, seq: e.seq, at: e["at"] };
      return;
    }
    if (REPLACES.has(e.type) && e["id"] !== undefined) {
      // Within the current turn only (ids are not reused across turns anyway).
      for (let i = h.length - 1; i >= 0 && h[i]!.type !== "prompt"; i--) {
        if (h[i]!.type === e.type && h[i]!["id"] === e["id"]) {
          h.splice(i, 1);
          break;
        }
      }
    }
    h.push(e);
    if (h.length > HISTORY) this.trim();
  }

  /** Back under HISTORY: drop whole turns from the front; if the current turn is
   * itself too long, keep its prompt and drop the oldest events after it. */
  private trim(): void {
    const h = this.history;
    const cut = h.length - HISTORY;
    const next = h.findIndex((e, i) => i >= cut && e.type === "prompt");
    if (next >= 0) {
      h.splice(0, next);
      return;
    }
    let p = -1;
    for (let i = cut - 1; i >= 0; i--) {
      if (h[i]!.type === "prompt") {
        p = i;
        break;
      }
    }
    if (p < 0) h.splice(0, cut);
    else h.splice(0, cut + 1, h[p]!); // the turn's prompt stays at the front
  }

  private send(chunk: string): void {
    for (const c of this.clients) c.write(chunk);
  }
}
