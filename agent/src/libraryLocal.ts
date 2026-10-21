/**
 * The effects library for the agent without the cloud relay (stdio, the one-shot
 * CLI): the same library (relay/src/library.ts) and the same tools, kept in one
 * JSON file in the agent's state dir (`<state dir>/effects-library.json`; the
 * state dir is the bridge's: $SPLANC_BRIDGE_STATE_DIR, else
 * ~/.local/state/splanc). Behind the relay (`splanc-agent bridge`) the relay
 * holds the library and serves these tools itself, so the bridge registers none.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  EffectLibrary,
  LIBRARY_LIMITS,
  LIBRARY_TOOLS,
  callLibraryTool,
  type EffectMeta,
  type LibraryStore,
} from "../relay/src/library";
import { defaultStateDir } from "./bridge/identity";

interface FileData {
  v: 1;
  entries: Record<string, EffectMeta>;
  sources: Record<string, string>;
  flags: Record<string, unknown>;
}

export function libraryPath(stateDir = defaultStateDir()): string {
  return join(stateDir, "effects-library.json");
}

/** One JSON file, written atomically on every change; in memory when `path` is null. */
export class FileLibraryStore implements LibraryStore {
  private data: FileData | null = null;

  constructor(readonly path: string | null) {}

  private load(): FileData {
    if (this.data) return this.data;
    let d: FileData = { v: 1, entries: {}, sources: {}, flags: {} };
    if (this.path) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FileData>;
        d = { v: 1, entries: raw.entries ?? {}, sources: raw.sources ?? {}, flags: raw.flags ?? {} };
      } catch {
        // none yet (or unreadable: start empty rather than fail the tool)
      }
    }
    this.data = d;
    return d;
  }

  private save(): void {
    if (!this.path || !this.data) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  async loadAll(): Promise<EffectMeta[]> {
    return Object.values(this.load().entries).map((m) => structuredClone(m));
  }

  async getSource(id: string): Promise<string | undefined> {
    return this.load().sources[id];
  }

  async put(meta: EffectMeta, source?: string): Promise<void> {
    const d = this.load();
    d.entries[meta.id] = structuredClone(meta);
    if (source !== undefined) d.sources[meta.id] = source;
    this.save();
  }

  async remove(ids: string[]): Promise<void> {
    const d = this.load();
    for (const id of ids) {
      delete d.entries[id];
      delete d.sources[id];
    }
    this.save();
  }

  async getFlag<T>(key: string): Promise<T | undefined> {
    return this.load().flags[key] as T | undefined;
  }

  async setFlag<T>(key: string, value: T): Promise<void> {
    this.load().flags[key] = value;
    this.save();
  }
}

/** The agent's own library (stdio / CLI). `path: null` keeps it in memory. */
export function localLibrary(path: string | null = libraryPath()): EffectLibrary {
  return new EffectLibrary(new FileLibraryStore(path));
}

// zod mirrors of LIBRARY_TOOLS' JSON schemas (the McpServer wants zod); the
// library validates every argument itself, and library_test checks the two agree.
const tags = z.array(z.string().max(LIBRARY_LIMITS.tag)).max(LIBRARY_LIMITS.tags);
const uniforms = z.array(z.object({ name: z.string() }).passthrough()).max(LIBRARY_LIMITS.uniforms);
const perf = z.record(z.string(), z.unknown());
const id = z.string();
const name = z.string().max(LIBRARY_LIMITS.name);
const description = z.string().max(LIBRARY_LIMITS.description);

const SHAPES: Record<string, z.ZodRawShape> = {
  search_effects: {
    query: z.string().optional(),
    tags: tags.optional(),
    limit: z.number().int().min(1).max(LIBRARY_LIMITS.maxResults).optional(),
  },
  get_effect: { id },
  save_effect: {
    name,
    description,
    tags: tags.optional(),
    source: z.string(),
    uniforms: uniforms.optional(),
    perf: perf.optional(),
  },
  duplicate_effect: { id, name: name.optional(), description: description.optional() },
  update_effect: {
    id,
    name: name.optional(),
    description: description.optional(),
    tags: tags.optional(),
    source: z.string().optional(),
    uniforms: uniforms.optional(),
    perf: perf.optional(),
  },
  delete_effect: { id },
};

/** deploy_effect's library arguments, as zod (server.ts adds them to its schema). */
export const DEPLOY_LIBRARY_SHAPE = {
  library_id: z.string().optional().describe("Deploy a library entry (search_effects) instead of passing source."),
  name: name.optional().describe("Library name for this effect (successful deploys are kept in the library)."),
  description: description.optional().describe("What it looks like / the mood (for the library)."),
  tags: tags.optional().describe("Library keywords: mood, colours, motion."),
};

export function libraryShape(tool: string): z.ZodRawShape {
  return SHAPES[tool]!;
}

/** Register the library tools on an McpServer, backed by `lib`. */
export function registerLibraryTools(server: McpServer, lib: EffectLibrary): void {
  for (const t of LIBRARY_TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: SHAPES[t.name]!, annotations: t.annotations },
      async (args: Record<string, unknown>) => ({ ...(await callLibraryTool(lib, t.name, args)) }),
    );
  }
}
