/**
 * Per-effect AI chat persistence (FUG-87 review). The effect editor's AI chat is
 * a running conversation; navigating away used to drop it. We persist two views
 * per effect in localStorage:
 *   - `history`: the API conversation ({@link ChatMessage}[]) so the model can
 *     continue where it left off;
 *   - `transcript`: the visible bubbles ({role,text}) so the log redraws.
 *
 * Images captured for the vision tool are stripped before saving (they'd blow
 * the storage quota and aren't useful across reloads — the model can re-capture).
 * History is trimmed at safe round boundaries so a truncated conversation stays
 * valid (never starts mid tool-call). Cleared only via the editor's "New chat".
 */

import type { ChatMessage, ContentBlock } from "../effects/ai/provider";

export type TranscriptRole = "user" | "assistant" | "tool";
export interface ChatTranscriptEntry {
  role: TranscriptRole;
  text: string;
}
export interface ChatSnapshot {
  history: ChatMessage[];
  transcript: ChatTranscriptEntry[];
}

const PREFIX = "ledmapper.fxchat.";
/** Keep recent context bounded (both views), for storage + prompt size. */
const MAX_MESSAGES = 60;

function storageKey(effectId: string): string {
  return PREFIX + effectId;
}

/** Replace captured preview images with a short placeholder (see file docstring). */
export function stripImages(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) => {
    if (typeof m.content === "string") return m;
    const content: ContentBlock[] = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      return {
        ...b,
        content: b.content.map((c) =>
          c.type === "image" ? { type: "text", text: "[preview image omitted]" } : c,
        ),
      };
    });
    return { ...m, content };
  });
}

/** Trim to at most MAX_MESSAGES, cutting only at a round boundary (a user turn
 * with string content) so we never begin the history on a dangling tool result. */
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_MESSAGES) return history;
  const start = history.length - MAX_MESSAGES;
  for (let i = start; i < history.length; i++) {
    const m = history[i];
    if (m && m.role === "user" && typeof m.content === "string") return history.slice(i);
  }
  return history; // no safe cut point — keep all rather than corrupt the round
}

export function loadChat(effectId: string): ChatSnapshot {
  try {
    const raw = localStorage.getItem(storageKey(effectId));
    if (!raw) return { history: [], transcript: [] };
    const parsed = JSON.parse(raw) as Partial<ChatSnapshot>;
    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      transcript: Array.isArray(parsed.transcript) ? parsed.transcript : [],
    };
  } catch {
    return { history: [], transcript: [] };
  }
}

export function saveChat(effectId: string, snap: ChatSnapshot): void {
  try {
    const history = trimHistory(stripImages(snap.history));
    const transcript = snap.transcript.slice(-MAX_MESSAGES);
    localStorage.setItem(storageKey(effectId), JSON.stringify({ history, transcript }));
  } catch {
    // quota / unavailable — the in-session chat still works
  }
}

export function clearChat(effectId: string): void {
  try {
    localStorage.removeItem(storageKey(effectId));
  } catch {
    // ignore
  }
}
