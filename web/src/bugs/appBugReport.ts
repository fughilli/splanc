/**
 * file_bug for the app's AI (the effect editor's chat and Acid Mode): the shared
 * tool (bugReport.ts) with the app's diagnostics and its way of filing directly —
 * POST <relay>/bugs with the app's relay credential when the user paired the app
 * with a bridge (per-bridge limits), anonymously otherwise (per IP). The user
 * confirms in a dialog before anything is filed, even when the model already
 * passed user_confirmed. docs/design/agent-bug-reports.md.
 */

import { appBuildInfo } from "../buildInfo";
import { getAiConfig } from "../effects/ai/provider";
import type { LedMapperClient } from "../net/client";
import {
  effectHash,
  fileBug,
  submitDirect,
  type BugSurface,
  type DuplicateCandidate,
  type PreparedIssue,
} from "./bugReport";

/** The relay the app files through when it has no paired bridge (also
 * ui/screens/bridgeLive.ts DEFAULT_RELAY). */
export const APP_RELAY = "https://splanc.pages.dev";
/** bridgeLive.ts's credential store ({relay, token}): read here, never written. */
const BRIDGE_CREDS_KEY = "splanc.bridge.v1";

export interface AppBugDeps {
  surface: Extract<BugSurface, "web-editor" | "web-acid">;
  /** The effect being worked on (only its hash is reported unless attached). */
  source: () => string;
  /** The connected player, if any. */
  client: () => LedMapperClient | null;
  /** Which AI the user runs (kind/model; never a key). */
  ai?: () => Record<string, unknown>;
  /** Ask the user before filing directly; false = don't file. */
  confirm: (issue: PreparedIssue) => Promise<boolean>;
  /** Tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  duplicates?: (title: string) => Promise<{ candidates: DuplicateCandidate[]; error?: string }>;
  creds?: () => { relay: string; token: string } | null;
}

function storedCreds(): { relay: string; token: string } | null {
  try {
    const raw = globalThis.localStorage?.getItem(BRIDGE_CREDS_KEY);
    const c = raw ? (JSON.parse(raw) as { relay?: unknown; token?: unknown }) : null;
    return c && typeof c.relay === "string" && typeof c.token === "string" && c.relay && c.token
      ? { relay: c.relay, token: c.token }
      : null;
  } catch {
    return null;
  }
}

/** A coarse browser/OS label (no version build numbers, no device model). */
export function coarseUserAgent(ua: string): string {
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "other";
  const m = /(Edg|OPR|Firefox|Chrome|CriOS|Version)\/(\d+)/.exec(ua);
  const name = !m ? "other" : m[1] === "Version" ? "Safari" : m[1] === "Edg" ? "Edge" : m[1] === "OPR" ? "Opera" : m[1] === "CriOS" ? "Chrome" : m[1];
  return `${name}${m ? ` ${m[2]}` : ""} on ${os}`;
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);

/** The app's safe diagnostics: versions, browser, the connected player's
 * firmware/board/LED count, and a hash of the effect being edited. */
export async function appDiagnostics(deps: Pick<AppBugDeps, "source" | "client" | "ai">): Promise<Record<string, unknown>> {
  const src = deps.source();
  const out: Record<string, unknown> = {
    app: {
      version: appBuildInfo.version ?? "dev",
      commit: appBuildInfo.gitCommitShort || null,
      dirty: appBuildInfo.gitDirty,
    },
    browser: coarseUserAgent(globalThis.navigator?.userAgent ?? ""),
    effect_hash: src.trim() ? await effectHash(src) : null,
    effect_source_lines: src.trim() ? src.split("\n").length : 0,
  };
  if (deps.ai) out["ai"] = deps.ai();
  const c = deps.client();
  const w = c?.welcome ?? null;
  if (!c || !w) {
    out["player"] = "none connected";
    return out;
  }
  const hw = await timeout(c.getHardwareConfig(), 3000);
  const channels = hw?.channels ?? [];
  out["player"] = {
    firmware: { version: w.fwVersion || null, commit: w.fwGitCommit ? w.fwGitCommit.slice(0, 12) : null, dirty: w.fwGitDirty },
    features: [...(w.features ?? [])].sort(),
    board: hw?.board?.board ?? null,
    channels: channels.length || null,
    led_count: channels.reduce((n, ch) => n + (ch.ledCount ?? 0), 0) || null,
    max_leds: hw?.board?.maxLeds ?? null,
  };
  return out;
}

/** Which AI the app runs (provider kind, cloud vendor + model; never a key). */
export function aiSummary(): Record<string, unknown> {
  try {
    const c = getAiConfig();
    if (c.kind !== "cloud") return { kind: c.kind };
    return { kind: c.kind, vendor: c.cloud.vendor, model: c.cloud.vendors[c.cloud.vendor]?.model ?? null };
  } catch {
    return { kind: "unknown" };
  }
}

/** The confirmation the screens show before filing directly. */
export function confirmFilingText(issue: PreparedIssue): { title: string; message: string; confirmLabel: string; cancelLabel: string } {
  return {
    title: "File this bug on GitHub?",
    message:
      `"${issue.title}" will be filed as a public issue on github.com/Studio-Fug/splanc (severity ${issue.severity}, ` +
      "labelled agent-filed). Passwords, tokens, keys and exact addresses were removed; your effect's source is " +
      "included only if you agreed to attach it.",
    confirmLabel: "File it",
    cancelLabel: "Not now",
  };
}

/** ChatHooks.onFileBug for an app screen. */
export function appFileBugHook(deps: AppBugDeps): (args: unknown) => Promise<string> {
  return async (args) => {
    const creds = (deps.creds ?? storedCreds)();
    const r = await fileBug(args, {
      surface: deps.surface,
      diagnostics: () => appDiagnostics(deps),
      ...(deps.duplicates ? { duplicates: deps.duplicates } : {}),
      direct: async (issue) => {
        if (!(await deps.confirm(issue))) {
          return { ok: false, reason: "rejected", message: "the user chose not to file it" };
        }
        return submitDirect(creds?.relay ?? APP_RELAY, issue, {
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(creds ? { headers: () => ({ authorization: `Bearer ${creds.token}` }) } : {}),
        });
      },
    });
    return JSON.stringify(r, null, 2);
  };
}
