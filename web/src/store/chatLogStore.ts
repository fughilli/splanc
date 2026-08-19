/**
 * ChatLogStore — persists FX-agent conversations on the device so a developer
 * can pull them off and debug why the agent failed to complete a request.
 *
 * The live chat history (`effectEditor.ts` / `acidMode.ts`) is in-memory only and
 * evaporates when the screen closes. This store snapshots each session's full
 * transcript — user asks, assistant text, tool_use / tool_result blocks, and any
 * AI error — after every turn, into a DEDICATED IndexedDB database
 * (`ledmapper-chatlog`) so it never has to touch the shared `ledmapper` DB's
 * version/upgrade coordination (mapStore + effectStore both own that one).
 *
 * Settings ▸ Debugging ships these to the host-side `tools/browser_server.py`
 * `/chatlogs` endpoint (or downloads them as JSON), the same pull path already
 * used for the effects library.
 *
 * Base64 image bytes from `capture_preview` tool results are REDACTED to a size
 * placeholder — they're huge, and the tool-call sequence + text is what matters
 * for debugging agent behaviour. Everything else is kept verbatim.
 */

import type { ChatMessage, ContentBlock } from "../effects/ai/generate";
import { debugServerUrl, postJson } from "../net/debugServer";

/** Which screen ran the agent — the two chat surfaces persist to the same log. */
export type ChatLogScreen = "effectEditor" | "acidMode";

/** One persisted conversation. Keyed by `id`; upserted after every turn so a
 * crash/close mid-session still leaves the transcript up to the last reply. */
export interface ChatLogSession {
  id: string;
  screen: ChatLogScreen;
  /** The effect being edited (acid mode uses its stable id), for cross-ref. */
  effectId?: string | undefined;
  effectName?: string | undefined;
  startedAt: string;
  updatedAt: string;
  /** Number of user asks in this session. */
  turns: number;
  /** True if the latest turn ended in an AI error (surfaced to the user). */
  errored: boolean;
  /** The most recent AI error message, if any — the thing to debug. */
  lastError?: string | undefined;
  userAgent: string;
  /** Full transcript (image bytes redacted). Shape matches the Anthropic API. */
  messages: ChatMessage[];
}

/** What a caller supplies each turn; the store stamps timestamps + redacts. */
export interface ChatLogUpdate {
  id: string;
  screen: ChatLogScreen;
  effectId?: string | undefined;
  effectName?: string | undefined;
  turns: number;
  errored: boolean;
  lastError?: string | undefined;
  messages: ChatMessage[];
}

const DB_NAME = "ledmapper-chatlog";
const DB_VERSION = 1;
const STORE = "sessions";
/** Keep the log bounded — prune to the most-recently-updated N on each write. */
const MAX_SESSIONS = 50;

/** Deep-clone the transcript, replacing base64 image data in tool_result blocks
 * with a size placeholder so a stored/uploaded log stays small and readable.
 * Never mutates the caller's live history. */
function redactMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const blocks: ContentBlock[] = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      return {
        ...b,
        content: b.content.map((c) =>
          c.type === "image"
            ? {
                type: "text" as const,
                text: `[image redacted: ${c.source.media_type}, ${c.source.data.length} b64 chars]`,
              }
            : c,
        ),
      };
    });
    return { role: m.role, content: blocks };
  });
}

class ChatLogStore {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (this.dbp === null) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }

  private tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
    return this.db().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction([STORE], mode);
          let result: T;
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          Promise.resolve(fn(tx.objectStore(STORE)))
            .then((r) => (result = r))
            .catch(reject);
        }),
    );
  }

  private static req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** Upsert a session's transcript. Idempotent per `id` — call after each turn.
   * Best-effort: logging must never break a chat, so failures are swallowed.
   * When the turn ERRORED and a debug server is configured, also auto-pushes the
   * session there (Option 3) so a failing session lands off-device with no tap. */
  async record(update: ChatLogUpdate): Promise<void> {
    try {
      const now = new Date().toISOString();
      const messages = redactMessages(update.messages);
      let rec: ChatLogSession | null = null;
      await this.tx("readwrite", async (s) => {
        const prev = await ChatLogStore.req(s.get(update.id) as IDBRequest<ChatLogSession | undefined>);
        rec = {
          id: update.id,
          screen: update.screen,
          effectId: update.effectId,
          effectName: update.effectName,
          startedAt: prev?.startedAt ?? now,
          updatedAt: now,
          turns: update.turns,
          errored: update.errored,
          lastError: update.lastError,
          userAgent: navigator.userAgent,
          messages,
        };
        s.put(rec);
      });
      await this.prune();
      if (update.errored && rec) void this.autoPush(rec);
    } catch {
      // Persisting a debug log is never worth surfacing to the user.
    }
  }

  /** Push one session to the debug server's /chatlogs (best-effort). Only fires
   * when a server is configured; the server merges by id, so error auto-pushes
   * accumulate alongside a later manual "Send AI chat logs". */
  private async autoPush(session: ChatLogSession): Promise<void> {
    const base = debugServerUrl();
    if (!base) return;
    try {
      await postJson(base, "/chatlogs", {
        exportedAt: session.updatedAt,
        count: 1,
        userAgent: session.userAgent,
        sessions: [session],
      });
    } catch {
      // Best-effort; the manual "Send AI chat logs" button is the fallback.
    }
  }

  /** Print all sessions to console.log (Option 1). Capacitor forwards this to the
   * iOS device console, which `bazel run //tools:ios_deploy -- --log` (devicectl)
   * streams back — so an agent can pull the logs off a physical iPhone. Chunked
   * with a stable marker so long transcripts survive per-line console limits;
   * reassemble by concatenating the `[chatlog-dump] i/N …` slices in order. */
  async dumpToConsole(): Promise<void> {
    const sessions = await this.list();
    const payload = {
      exportedAt: new Date().toISOString(),
      count: sessions.length,
      userAgent: navigator.userAgent,
      sessions,
    };
    const json = JSON.stringify(payload);
    const CHUNK = 4000;
    const total = Math.max(1, Math.ceil(json.length / CHUNK));
    console.log(`[chatlog-dump] BEGIN ${sessions.length} session(s), ${json.length} chars, ${total} chunk(s)`);
    for (let i = 0; i < total; i++) {
      console.log(`[chatlog-dump] ${i + 1}/${total} ${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    }
    console.log("[chatlog-dump] END");
  }

  /** Drop the oldest sessions beyond MAX_SESSIONS (by updatedAt). */
  private async prune(): Promise<void> {
    await this.tx("readwrite", async (s) => {
      const keys = (await ChatLogStore.req(
        s.index("updatedAt").getAllKeys() as IDBRequest<IDBValidKey[]>,
      )) as IDBValidKey[];
      // getAllKeys on the index returns primary keys sorted by updatedAt asc.
      const excess = keys.length - MAX_SESSIONS;
      if (excess > 0) for (const k of keys.slice(0, excess)) s.delete(k);
    });
  }

  /** All sessions, most-recently-updated first. */
  async list(): Promise<ChatLogSession[]> {
    const all = await this.tx("readonly", (s) =>
      ChatLogStore.req(s.getAll() as IDBRequest<ChatLogSession[]>),
    );
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<ChatLogSession | undefined> {
    return this.tx("readonly", (s) =>
      ChatLogStore.req(s.get(id) as IDBRequest<ChatLogSession | undefined>),
    );
  }

  async clear(): Promise<void> {
    await this.tx("readwrite", (s) => s.clear());
  }
}

export const chatLogStore = new ChatLogStore();

/** A fresh session id for a chat surface to own for the lifetime of the screen. */
export function newChatLogSessionId(): string {
  return crypto.randomUUID();
}

// "Dump chat logs to the device console on launch" — a debug toggle (Settings ▸
// Debugging). When on, main.ts calls chatLogStore.dumpToConsole() at boot, so a
// relaunch via `ios_deploy --log` prints the logs to the captured device console.
const DUMP_ON_BOOT_KEY = "ledmapper.chatlog.dumpOnBoot";

export function chatLogDumpOnBootEnabled(): boolean {
  return localStorage.getItem(DUMP_ON_BOOT_KEY) === "1";
}

export function setChatLogDumpOnBoot(on: boolean): void {
  if (on) localStorage.setItem(DUMP_ON_BOOT_KEY, "1");
  else localStorage.removeItem(DUMP_ON_BOOT_KEY);
}
