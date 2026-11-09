/**
 * Hash router (design doc §3.3 / §7.3). Static host, no server routing — routes
 * are `#/onboard`, `#/maps`, `#/map/:id`, `#/map/:id/topology`, `#/effects`,
 * `#/capture`. Owns the active screen and mount/unmount of heavy views
 * (MapView, camera) so leaving a screen releases its GL contexts.
 */

export interface Screen {
  /** Root element to mount into the router outlet. */
  el: HTMLElement;
  /** Called after `el` is in the DOM. */
  onMount?: () => void;
  /** Called before `el` is removed — release GL/camera/timers here. */
  onUnmount?: () => void;
  /** Guard leaving this screen: return false (or a promise resolving false) to
   * CANCEL the navigation — the router restores the current route and the screen
   * stays mounted. Used for unsaved-changes prompts. Only consulted when the
   * route path actually changes. */
  beforeLeave?: () => boolean | Promise<boolean>;
}

export interface RouteMatch {
  params: Record<string, string>;
  query: URLSearchParams;
}

export type ScreenFactory = (m: RouteMatch) => Screen;

interface Route {
  pattern: string;
  parts: string[];
  factory: ScreenFactory;
}

/** history.state key marking an entry whose one-shot screen was left (#442). */
const ENDED_KEY = "splancLeftTo";

export class Router {
  private routes: Route[] = [];
  private fallback: ScreenFactory | null = null;
  private current: Screen | null = null;
  // The path the mounted screen lives at, and a flag set while we programmatically
  // restore the hash after a vetoed leave (so that restore's hashchange is ignored).
  private currentPath = "";
  private restoringHash = false;
  // History bookkeeping for leave() (#442): the hash navigate() just pushed and
  // the path it was pushed from, and — once that push resolves — the path the
  // mounted screen was entered from. Null when the screen was reached any other
  // way (deep link, reload, browser Back/Forward into an old entry).
  private pendingPush: { hash: string; from: string } | null = null;
  private enteredFrom: string | null = null;
  // Set while leave()'s history.back() is in flight (browsers traverse on a
  // later task), with a navigate() that arrived meanwhile. It runs once the
  // traversal lands: run now, the stamped entry would redirect it away.
  private popping: { to: string; then: string | null } | null = null;

  constructor(private readonly outlet: HTMLElement) {}

  add(pattern: string, factory: ScreenFactory): this {
    this.routes.push({ pattern, parts: pattern.split("/").filter(Boolean), factory });
    return this;
  }

  setFallback(factory: ScreenFactory): this {
    this.fallback = factory;
    return this;
  }

  start(): void {
    window.addEventListener("hashchange", () => void this.resolve());
    void this.resolve();
  }

  /** Navigate to a hash path, e.g. `navigate("/map/abc")`. */
  navigate(path: string): void {
    if (this.popping) {
      this.popping.then = path;
      return;
    }
    const next = `#${path.startsWith("/") ? path : `/${path}`}`;
    if (location.hash === next) void this.resolve();
    else {
      this.pendingPush = { hash: next, from: this.currentPath };
      location.hash = next;
    }
  }

  /** Navigate to `path` REPLACING the current history entry (no new entry), so
   * Back from `path` skips the screen being left. */
  replace(path: string): void {
    const next = `#${path.startsWith("/") ? path : `/${path}`}`;
    this.pendingPush = null;
    if (location.hash === next) {
      void this.resolve();
      return;
    }
    location.replace(next);
  }

  /** Leave a one-shot screen (a capture session) for `path` so that history
   * can never re-enter — and so restart — it (#442):
   *  - the screen's history entry is stamped "ended → path" (history.state), so
   *    a later Back/Forward/reload landing on it is redirected to `path`
   *    instead of mounting the screen again;
   *  - if the screen was pushed from `path` itself, pop back to that entry
   *    (no duplicate entry); otherwise replace the screen's entry with `path`. */
  leave(path: string): void {
    const norm = path.startsWith("/") ? path : `/${path}`;
    const next = `#${norm}`;
    const h = globalThis.history;
    try {
      const prev = (h?.state ?? {}) as Record<string, unknown>;
      h?.replaceState({ ...prev, [ENDED_KEY]: next }, "");
    } catch {
      /* no history API (tests / exotic webviews): replace below still applies */
    }
    if (this.enteredFrom !== null && this.enteredFrom === norm && h !== undefined) {
      this.enteredFrom = null;
      this.popping = { to: next, then: null };
      h.back();
      // Should the traversal never report (no hashchange), don't hold navigation.
      setTimeout(() => this.landed(next), 1000);
      return;
    }
    this.replace(norm);
  }

  /** The path the mounted screen was pushed from by navigate(), or null when it
   * was reached by a deep link / reload / history traversal. */
  origin(): string | null {
    return this.enteredFrom;
  }

  back(): void {
    history.back();
  }

  /** The current route path (without the leading '#'), e.g. "/maps". */
  path(): string {
    const raw = location.hash.replace(/^#/, "");
    return raw.split("?")[0] || "/";
  }

  /** leave()'s pop has landed on `hash` (or timed out): run a deferred navigate. */
  private landed(hash: string): void {
    const p = this.popping;
    if (!p || p.to !== hash) return;
    this.popping = null;
    if (p.then !== null) this.navigate(p.then);
  }

  private async resolve(): Promise<void> {
    if (this.popping && location.hash === this.popping.to) {
      const to = this.popping.to;
      await this.resolveNow();
      this.landed(to);
      return;
    }
    await this.resolveNow();
  }

  private async resolveNow(): Promise<void> {
    // Ignore the hashchange we caused by restoring the route after a vetoed leave.
    if (this.restoringHash) {
      this.restoringHash = false;
      return;
    }
    // An entry a one-shot screen was left from (see leave()): never re-mount
    // it; go where it was left to instead (replacing the stale entry).
    const ended = (globalThis.history?.state as Record<string, unknown> | null | undefined)?.[ENDED_KEY];
    if (typeof ended === "string" && ended !== location.hash) {
      this.pendingPush = null;
      location.replace(ended);
      return;
    }
    const push = this.pendingPush;
    this.pendingPush = null;
    const pushedFrom = push !== null && push.hash === location.hash ? push.from : null;
    const raw = location.hash.replace(/^#/, "") || "/onboard";
    const [pathPart, queryPart] = raw.split("?");
    const path = pathPart || "/onboard";

    // Leave-guard: only when the screen path actually changes. If the mounted
    // screen vetoes (unsaved changes → user cancels), put the hash back and keep
    // it mounted. `await` is skipped entirely for screens without a guard, so
    // normal navigation stays synchronous.
    if (this.current?.beforeLeave && path !== this.currentPath) {
      const ok = await this.current.beforeLeave();
      if (!ok) {
        this.restoringHash = true;
        location.hash = `#${this.currentPath}`;
        return;
      }
    }

    const query = new URLSearchParams(queryPart ?? "");
    const segs = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      const params = matchRoute(route.parts, segs);
      if (params !== null) {
        if (path !== this.currentPath) this.enteredFrom = pushedFrom;
        this.currentPath = path;
        this.mount(route.factory({ params, query }));
        return;
      }
    }
    if (this.fallback) {
      if (path !== this.currentPath) this.enteredFrom = pushedFrom;
      this.currentPath = path;
      this.mount(this.fallback({ params: {}, query }));
    }
  }

  private mount(screen: Screen): void {
    if (this.current) {
      this.current.onUnmount?.();
      this.current.el.remove();
    }
    this.current = screen;
    this.outlet.appendChild(screen.el);
    // Fresh screen starts at the top: don't inherit the previous screen's scroll
    // offset (or its in-flight momentum/smooth scroll) through the shared outlet.
    this.outlet.scrollTop = 0;
    screen.onMount?.();
  }
}

function matchRoute(parts: string[], segs: string[]): Record<string, string> | null {
  if (parts.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const s = segs[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return params;
}
