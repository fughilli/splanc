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

export class Router {
  private routes: Route[] = [];
  private fallback: ScreenFactory | null = null;
  private current: Screen | null = null;
  // The path the mounted screen lives at, and a flag set while we programmatically
  // restore the hash after a vetoed leave (so that restore's hashchange is ignored).
  private currentPath = "";
  private restoringHash = false;

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
    const next = `#${path.startsWith("/") ? path : `/${path}`}`;
    if (location.hash === next) void this.resolve();
    else location.hash = next;
  }

  back(): void {
    history.back();
  }

  /** The current route path (without the leading '#'), e.g. "/maps". */
  path(): string {
    const raw = location.hash.replace(/^#/, "");
    return raw.split("?")[0] || "/";
  }

  private async resolve(): Promise<void> {
    // Ignore the hashchange we caused by restoring the route after a vetoed leave.
    if (this.restoringHash) {
      this.restoringHash = false;
      return;
    }
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
        this.currentPath = path;
        this.mount(route.factory({ params, query }));
        return;
      }
    }
    if (this.fallback) {
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
