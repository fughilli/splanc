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
    window.addEventListener("hashchange", () => this.resolve());
    this.resolve();
  }

  /** Navigate to a hash path, e.g. `navigate("/map/abc")`. */
  navigate(path: string): void {
    const next = `#${path.startsWith("/") ? path : `/${path}`}`;
    if (location.hash === next) this.resolve();
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

  private resolve(): void {
    const raw = location.hash.replace(/^#/, "") || "/onboard";
    const [pathPart, queryPart] = raw.split("?");
    const path = pathPart || "/onboard";
    const query = new URLSearchParams(queryPart ?? "");
    const segs = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      const params = matchRoute(route.parts, segs);
      if (params !== null) {
        this.mount(route.factory({ params, query }));
        return;
      }
    }
    if (this.fallback) this.mount(this.fallback({ params: {}, query }));
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
