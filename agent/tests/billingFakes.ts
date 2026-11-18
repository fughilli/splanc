/**
 * Shared fakes for the relay billing tests: in-memory Durable Object storage
 * that yields on every call (so interleavings happen) and a namespace that
 * makes one object per name.
 */

import type { DONamespace, DOState, DOStorage } from "../relay/src/platform";

/** In-memory DO storage that YIELDS on every call, so interleavings happen. */
export class MemStorage implements DOStorage {
  readonly map = new Map<string, unknown>();
  alarm: number | null = null;
  private tick = () => new Promise<void>((r) => setImmediate(r));
  async get<T>(k: string | string[]): Promise<never> {
    await this.tick();
    if (Array.isArray(k)) return new Map(k.filter((x) => this.map.has(x)).map((x) => [x, structuredClone(this.map.get(x)) as T])) as never;
    return structuredClone(this.map.get(k)) as never;
  }
  async put<T>(k: string | Record<string, T>, v?: T): Promise<void> {
    await this.tick();
    if (typeof k === "string") this.map.set(k, structuredClone(v));
    else for (const [a, b] of Object.entries(k)) this.map.set(a, structuredClone(b));
  }
  async delete(k: string | string[]): Promise<never> {
    await this.tick();
    if (Array.isArray(k)) return k.filter((x) => this.map.delete(x)).length as never;
    return this.map.delete(k) as never;
  }
  async list<T>(o: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    await this.tick();
    const keys = [...this.map.keys()].filter((x) => x.startsWith(o.prefix ?? "")).sort();
    return new Map(keys.slice(0, o.limit ?? keys.length).map((x) => [x, structuredClone(this.map.get(x)) as T]));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t: number) {
    this.alarm = t;
  }
}

export function memState(): DOState & { storage: MemStorage } {
  return { storage: new MemStorage(), acceptWebSocket() {}, getWebSockets: () => [] };
}

export function namespace(make: (s: DOState) => { fetch(r: Request): Promise<Response> }): DONamespace & { objects: Map<string, { state: DOState & { storage: MemStorage } }> } {
  const objects = new Map<string, { state: DOState & { storage: MemStorage }; obj: { fetch(r: Request): Promise<Response> } }>();
  return {
    objects,
    idFromName: (n: string) => n,
    get: (id: unknown) => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        let o = objects.get(String(id));
        if (!o) {
          const state = memState();
          o = { state, obj: make(state) };
          objects.set(String(id), o);
        }
        return o.obj.fetch(new Request(input, init));
      },
    }),
  };
}
