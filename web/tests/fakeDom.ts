/**
 * A small, dependency-free fake DOM for the node:test suites that exercise the
 * vanilla-TS UI (src/ui/**): just enough of Document / Element / Event for the
 * kit factories and screens to build real element trees that a test can query,
 * click, type into and inspect. It is NOT a browser — no layout, no CSS
 * cascade, no HTML parser — so tests assert on structure, classes, attributes,
 * inline styles and callbacks, which is what the UI code itself manipulates.
 *
 *   const dom = installFakeDom();          // globalThis.document / window / …
 *   const s = Slider({...});
 *   setValue(s.input, "1.2"); fire(s.input, "input");
 *   dom.flushAnimationFrames();            // run queued requestAnimationFrame cbs
 *   dom.uninstall();                       // restore the previous globals
 *
 * Observers (IntersectionObserver / ResizeObserver) are recorded, never fired
 * on their own: a test drives visibility with `dom.intersect(el, true)`.
 */

type ListenerFn = ((ev: Event) => unknown) | { handleEvent(ev: Event): unknown };
interface Listener {
  fn: ListenerFn;
  capture: boolean;
  once: boolean;
}
type ListenerOpts = boolean | { capture?: boolean; once?: boolean; passive?: boolean; signal?: AbortSignal };

function optCapture(o?: ListenerOpts): boolean {
  return typeof o === "boolean" ? o : !!o?.capture;
}

/** Listener registry with DOM-style capture/target/bubble dispatch along the
 * parent chain (`eventParent`). */
export class FakeEventTarget {
  private readonly _listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: ListenerFn | null, opts?: ListenerOpts): void {
    if (!fn) return;
    const capture = optCapture(opts);
    const list = this._listeners.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    const once = typeof opts === "object" && !!opts.once;
    const entry: Listener = { fn, capture, once };
    list.push(entry);
    this._listeners.set(type, list);
    if (typeof opts === "object" && opts.signal) {
      opts.signal.addEventListener("abort", () => this.removeEventListener(type, fn, capture));
    }
  }

  removeEventListener(type: string, fn: ListenerFn | null, opts?: ListenerOpts): void {
    if (!fn) return;
    const capture = optCapture(opts);
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }

  /** Number of listeners registered for `type` (test introspection). */
  listenerCount(type: string): number {
    return this._listeners.get(type)?.length ?? 0;
  }

  /** The next target up the propagation path (parent node; document → window). */
  eventParent(): FakeEventTarget | null {
    return null;
  }

  /** @internal invoke this target's listeners for one phase. */
  _invoke(ev: Event, phase: "capture" | "target" | "bubble"): void {
    const list = this._listeners.get(ev.type);
    if (!list) return;
    for (const l of [...list]) {
      if (phase === "capture" && !l.capture) continue;
      if (phase === "bubble" && l.capture) continue;
      if (l.once) this.removeEventListener(ev.type, l.fn, l.capture);
      define(ev, "currentTarget", this);
      if (typeof l.fn === "function") l.fn.call(this, ev);
      else l.fn.handleEvent(ev);
    }
  }

  dispatchEvent(ev: Event): boolean {
    define(ev, "target", this);
    const path: FakeEventTarget[] = [];
    for (let t = this.eventParent(); t; t = t.eventParent()) path.push(t);
    for (const t of [...path].reverse()) {
      if (ev.cancelBubble) break;
      t._invoke(ev, "capture");
    }
    if (!ev.cancelBubble) this._invoke(ev, "target");
    if (ev.bubbles) {
      for (const t of path) {
        if (ev.cancelBubble) break;
        t._invoke(ev, "bubble");
      }
    }
    define(ev, "currentTarget", null);
    return !ev.defaultPrevented;
  }
}

function define(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
}

// -- nodes --------------------------------------------------------------------

export class FakeNode extends FakeEventTarget {
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;
  static readonly DOCUMENT_FRAGMENT_NODE = 11;

  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public ownerDocument: FakeDocument | null,
  ) {
    super();
  }

  override eventParent(): FakeEventTarget | null {
    if (this.parentNode) return this.parentNode;
    if (this.nodeType === FakeNode.DOCUMENT_NODE) return (this as unknown as FakeDocument).defaultView;
    return null;
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): FakeNode | null {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i > 0 ? (p.childNodes[i - 1] ?? null) : null;
  }
  /** Attached (transitively) to a document. */
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n) {
      if (n.nodeType === FakeNode.DOCUMENT_NODE) return true;
      n = n.parentNode;
    }
    return false;
  }

  hasChildNodes(): boolean {
    return this.childNodes.length > 0;
  }

  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  private toNodes(items: (FakeNode | string)[]): FakeNode[] {
    const out: FakeNode[] = [];
    for (const it of items) {
      if (typeof it === "string") out.push(new FakeText(it, this.ownerDocument));
      else if (it.nodeType === FakeNode.DOCUMENT_FRAGMENT_NODE) out.push(...it.childNodes);
      else out.push(it);
    }
    return out;
  }

  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    const nodes = this.toNodes([node]);
    for (const n of nodes) {
      if (n.contains(this)) throw new Error("HierarchyRequestError: cycle");
      n.parentNode?.removeChild(n);
    }
    let at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (at < 0) throw new Error("NotFoundError: reference node is not a child");
    for (const n of nodes) {
      n.parentNode = this;
      this.childNodes.splice(at++, 0, n);
    }
    return node;
  }

  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null);
  }

  removeChild<T extends FakeNode>(node: T): T {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error("NotFoundError: not a child");
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  replaceChild<T extends FakeNode>(node: FakeNode, old: T): T {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }

  append(...items: (FakeNode | string)[]): void {
    for (const n of this.toNodes(items)) this.appendChild(n);
  }

  prepend(...items: (FakeNode | string)[]): void {
    const first = this.firstChild;
    for (const n of this.toNodes(items)) this.insertBefore(n, first);
  }

  replaceChildren(...items: (FakeNode | string)[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...items);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  before(...items: (FakeNode | string)[]): void {
    const p = this.parentNode;
    if (!p) return;
    for (const n of this.toNodes(items)) p.insertBefore(n, this);
  }

  after(...items: (FakeNode | string)[]): void {
    const p = this.parentNode;
    if (!p) return;
    const next = this.nextSibling;
    for (const n of this.toNodes(items)) p.insertBefore(n, next);
  }

  replaceWith(...items: (FakeNode | string)[]): void {
    const p = this.parentNode;
    if (!p) return;
    const next = this.nextSibling;
    p.removeChild(this);
    for (const n of this.toNodes(items)) p.insertBefore(n, next);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string | null) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== null && v !== "") this.appendChild(new FakeText(String(v), this.ownerDocument));
  }

  cloneNode(deep = false): FakeNode {
    const copy = this.shallowClone();
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }

  protected shallowClone(): FakeNode {
    return new FakeNode(this.nodeType, this.nodeName, this.ownerDocument);
  }

  // Query API on any container node (elements, fragments, documents).
  querySelectorAll(selector: string): FakeElement[] {
    const sel = parseSelector(selector);
    const out: FakeElement[] = [];
    walkElements(this, (el) => {
      if (matchesParsed(el, sel)) out.push(el);
    });
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    const c = this.children;
    return c[c.length - 1] ?? null;
  }
}

function walkElements(root: FakeNode, fn: (el: FakeElement) => void): void {
  for (const c of root.childNodes) {
    if (c instanceof FakeElement) {
      fn(c);
      walkElements(c, fn);
    }
  }
}

export class FakeText extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument | null,
  ) {
    super(FakeNode.TEXT_NODE, "#text", doc);
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(v: string | null) {
    this.data = v ?? "";
  }
  get nodeValue(): string {
    return this.data;
  }
  protected override shallowClone(): FakeNode {
    return new FakeText(this.data, this.ownerDocument);
  }
}

export class FakeComment extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument | null,
  ) {
    super(FakeNode.COMMENT_NODE, "#comment", doc);
  }
  override get textContent(): string {
    return "";
  }
  override set textContent(_v: string | null) {
    /* comments carry no text content */
  }
}

export class FakeDocumentFragment extends FakeNode {
  constructor(doc: FakeDocument | null) {
    super(FakeNode.DOCUMENT_FRAGMENT_NODE, "#document-fragment", doc);
  }
  protected override shallowClone(): FakeNode {
    return new FakeDocumentFragment(this.ownerDocument);
  }
}

// -- style / classList / dataset ---------------------------------------------

const camelToKebab = (s: string): string =>
  s.startsWith("--") ? s : s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const kebabToCamel = (s: string): string =>
  s.startsWith("--") ? s : s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** CSSStyleDeclaration subset: camelCase properties + setProperty/getPropertyValue
 * (custom properties included) + cssText, all backed by one map. */
export interface FakeStyle {
  setProperty(name: string, value: string | null, priority?: string): void;
  getPropertyValue(name: string): string;
  removeProperty(name: string): string;
  cssText: string;
  readonly length: number;
  [prop: string]: unknown;
}

function makeStyle(): FakeStyle {
  const props = new Map<string, string>();
  const api = {
    setProperty(name: string, value: string | null): void {
      const k = camelToKebab(name);
      if (value === null || value === "") props.delete(k);
      else props.set(k, String(value));
    },
    getPropertyValue(name: string): string {
      return props.get(camelToKebab(name)) ?? "";
    },
    removeProperty(name: string): string {
      const k = camelToKebab(name);
      const old = props.get(k) ?? "";
      props.delete(k);
      return old;
    },
    get cssText(): string {
      return [...props].map(([k, v]) => `${k}: ${v};`).join(" ");
    },
    set cssText(v: string) {
      props.clear();
      for (const decl of String(v).split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) props.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    },
    get length(): number {
      return props.size;
    },
  };
  return new Proxy(api as unknown as FakeStyle, {
    get(target, key) {
      if (typeof key !== "string" || key in target) return Reflect.get(target, key);
      return props.get(camelToKebab(key)) ?? "";
    },
    set(target, key, value) {
      if (typeof key !== "string" || key in target) return Reflect.set(target, key, value);
      api.setProperty(key, value === null || value === undefined ? null : String(value));
      return true;
    },
  });
}

class FakeTokenList {
  constructor(private readonly el: FakeElement) {}
  private get list(): string[] {
    return (this.el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  private set list(v: string[]) {
    this.el.setAttribute("class", v.join(" "));
  }
  get length(): number {
    return this.list.length;
  }
  get value(): string {
    return this.list.join(" ");
  }
  item(i: number): string | null {
    return this.list[i] ?? null;
  }
  contains(c: string): boolean {
    return this.list.includes(c);
  }
  add(...cs: string[]): void {
    const l = this.list;
    for (const c of cs) if (!l.includes(c)) l.push(c);
    this.list = l;
  }
  remove(...cs: string[]): void {
    this.list = this.list.filter((c) => !cs.includes(c));
  }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.contains(c);
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
  replace(a: string, b: string): boolean {
    if (!this.contains(a)) return false;
    this.list = this.list.map((c) => (c === a ? b : c));
    return true;
  }
  [Symbol.iterator](): Iterator<string> {
    return this.list[Symbol.iterator]();
  }
  toString(): string {
    return this.value;
  }
}

/** A 2D-context stand-in: records every method call; property writes stick. */
export function fakeCanvasContext(canvas: FakeElement): Record<string, unknown> & { calls: string[] } {
  const calls: string[] = [];
  const state: Record<string, unknown> = { canvas, calls };
  return new Proxy(state, {
    get(t, key) {
      if (typeof key !== "string") return undefined;
      if (key in t) return t[key];
      if (key === "measureText") return (s: string) => ({ width: String(s).length * 6 });
      if (key === "createLinearGradient" || key === "createRadialGradient" || key === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      if (key === "getImageData" || key === "createImageData") {
        return (...a: number[]) => {
          const w = a.length >= 4 ? a[2]! : a[0]!;
          const h = a.length >= 4 ? a[3]! : a[1]!;
          return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) };
        };
      }
      return (..._a: unknown[]) => {
        calls.push(key);
      };
    },
    set(t, key, value) {
      if (typeof key === "string") t[key] = value;
      return true;
    },
  }) as Record<string, unknown> & { calls: string[] };
}

const BOOLEAN_ATTRS = new Set(["hidden", "disabled", "checked", "selected", "readonly", "required", "open", "multiple"]);
const STRING_PROPS: Record<string, string> = {
  id: "id",
  title: "title",
  href: "href",
  src: "src",
  alt: "alt",
  name: "name",
  placeholder: "placeholder",
  type: "type",
  min: "min",
  max: "max",
  step: "step",
  accept: "accept",
  autocomplete: "autocomplete",
  role: "role",
  htmlFor: "for",
  download: "download",
  target: "target",
  rel: "rel",
  lang: "lang",
  dir: "dir",
};

export interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly localName: string;
  readonly attributes = new Map<string, string>();
  readonly style: FakeStyle = makeStyle();
  readonly classList: FakeTokenList = new FakeTokenList(this);
  readonly dataset: Record<string, string | undefined>;
  /** Form-control state (value is a property, distinct from the attribute). */
  private _value: string | null = null;
  /** Layout box reported by getBoundingClientRect / offset*. Tests set it. */
  rect: FakeRect = { x: 0, y: 0, width: 0, height: 0 };
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  tabIndex = -1;
  width = 300; // <canvas> intrinsic size defaults
  height = 150;
  private _ctx: ReturnType<typeof fakeCanvasContext> | null = null;
  /** innerHTML set as raw markup: the opaque text node standing in for it. */
  private _rawHtml: { node: FakeText; html: string } | null = null;
  [prop: string]: unknown;

  constructor(
    tag: string,
    doc: FakeDocument | null,
    readonly namespaceURI: string = "http://www.w3.org/1999/xhtml",
  ) {
    const html = namespaceURI === "http://www.w3.org/1999/xhtml";
    super(FakeNode.ELEMENT_NODE, html ? tag.toUpperCase() : tag, doc);
    this.tagName = html ? tag.toUpperCase() : tag;
    this.localName = html ? tag.toLowerCase() : tag;
    const self = this;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get(_t, key) {
        if (typeof key !== "string") return undefined;
        return self.getAttribute("data-" + camelToKebab(key)) ?? undefined;
      },
      set(_t, key, value) {
        if (typeof key === "string") self.setAttribute("data-" + camelToKebab(key), String(value));
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === "string") self.removeAttribute("data-" + camelToKebab(key));
        return true;
      },
      has(_t, key) {
        return typeof key === "string" && self.hasAttribute("data-" + camelToKebab(key));
      },
      ownKeys() {
        return [...self.attributes.keys()].filter((k) => k.startsWith("data-")).map((k) => kebabToCamel(k.slice(5)));
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== "string" || !self.hasAttribute("data-" + camelToKebab(key))) return undefined;
        return { enumerable: true, configurable: true, value: self.getAttribute("data-" + camelToKebab(key)) };
      },
    });
    // Reflect common string/boolean attributes as properties.
    for (const [prop, attr] of Object.entries(STRING_PROPS)) {
      Object.defineProperty(this, prop, {
        get: () => this.getAttribute(attr) ?? (prop === "type" && this.localName === "input" ? "text" : ""),
        set: (v: unknown) => this.setAttribute(attr, String(v)),
        configurable: true,
        enumerable: true,
      });
    }
    for (const attr of BOOLEAN_ATTRS) {
      // `checked`/`selected` are live form state; the rest reflect the attribute.
      Object.defineProperty(this, attr === "readonly" ? "readOnly" : attr, {
        get: () => this.hasAttribute(attr),
        set: (v: unknown) => this.toggleAttribute(attr, !!v),
        configurable: true,
        enumerable: true,
      });
    }
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }

  get value(): string {
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this._value = String(v);
  }
  get valueAsNumber(): number {
    return this.value === "" ? NaN : Number(this.value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }
  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }
  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  matches(selector: string): boolean {
    return matchesParsed(this, parseSelector(selector));
  }

  closest(selector: string): FakeElement | null {
    const sel = parseSelector(selector);
    for (let e: FakeElement | null = this; e; e = e.parentElement) if (matchesParsed(e, sel)) return e;
    return null;
  }

  get innerHTML(): string {
    const raw = this._rawHtml;
    if (raw && this.childNodes.length === 1 && this.childNodes[0] === raw.node) return raw.html;
    return this.childNodes.map(serialize).join("");
  }
  /** No HTML parser: "" clears; anything else becomes one opaque text node
   * whose textContent is the markup with tags stripped. */
  set innerHTML(v: string) {
    this.replaceChildren();
    this._rawHtml = null;
    if (v) {
      const node = new FakeText(String(v).replace(/<[^>]*>/g, ""), this.ownerDocument);
      this.appendChild(node);
      this._rawHtml = { node, html: String(v) };
    }
  }
  get outerHTML(): string {
    return serialize(this);
  }

  get innerText(): string {
    return this.textContent;
  }
  set innerText(v: string) {
    this.textContent = v;
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatchEvent(new Event("focus"));
  }
  blur(): void {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.dispatchEvent(new Event("blur"));
  }
  click(): void {
    if (this.hasAttribute("disabled")) return;
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  getBoundingClientRect(): DOMRectLike {
    const r = this.rect;
    return {
      x: r.x,
      y: r.y,
      left: r.x,
      top: r.y,
      width: r.width,
      height: r.height,
      right: r.x + r.width,
      bottom: r.y + r.height,
    };
  }
  get offsetWidth(): number {
    return this.rect.width;
  }
  get offsetHeight(): number {
    return this.rect.height;
  }
  get clientWidth(): number {
    return this.rect.width;
  }
  get clientHeight(): number {
    return this.rect.height;
  }

  scrollIntoView(): void {}
  scrollTo(): void {}
  scrollBy(): void {}
  /** <input>/<textarea> text selection: no layout, so selecting is a no-op. */
  select(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  hasPointerCapture(): boolean {
    return false;
  }
  animate(): { finished: Promise<void>; cancel(): void; onfinish: null } {
    return { finished: Promise.resolve(), cancel() {}, onfinish: null };
  }

  /** <canvas> only: a recording 2D context (see fakeCanvasContext). */
  getContext(kind: string): ReturnType<typeof fakeCanvasContext> | null {
    if (this.localName !== "canvas" || kind !== "2d") return null;
    this._ctx ??= fakeCanvasContext(this);
    return this._ctx;
  }

  protected override shallowClone(): FakeNode {
    const c = new FakeElement(this.localName, this.ownerDocument, this.namespaceURI);
    for (const [k, v] of this.attributes) c.attributes.set(k, v);
    return c;
  }
}

export interface DOMRectLike {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

function serialize(n: FakeNode): string {
  if (n instanceof FakeText) return n.data.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (!(n instanceof FakeElement)) return n.childNodes.map(serialize).join("");
  const attrs = [...n.attributes].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v}"`)).join("");
  return `<${n.localName}${attrs}>${n.innerHTML}</${n.localName}>`;
}

// -- selectors ------------------------------------------------------------------

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: { name: string; op: string | null; value: string }[];
  pseudos: { name: string; arg: string | null }[];
}
/** One complex selector: compounds right-to-left with the combinator that
 * links each to the next one leftward (" " descendant, ">" child). */
interface Complex {
  parts: { compound: Compound; combinator: " " | ">" | null }[];
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCompound(src: string): Compound {
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
  let s = src.trim();
  const tag = /^([a-zA-Z*][\w-]*)/.exec(s);
  if (tag) {
    c.tag = tag[1] === "*" ? null : tag[1]!.toLowerCase();
    s = s.slice(tag[0].length);
  }
  while (s.length) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(s))) c.ids.push(m[1]!);
    else if ((m = /^\.([\w-]+)/.exec(s))) c.classes.push(m[1]!);
    else if ((m = /^\[\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(s))) {
      c.attrs.push({ name: m[1]!.toLowerCase(), op: m[2] ?? null, value: m[3] ?? m[4] ?? m[5] ?? "" });
    } else if ((m = /^::?([\w-]+)(?:\(((?:[^()]|\([^()]*\))*)\))?/.exec(s))) {
      c.pseudos.push({ name: m[1]!, arg: m[2] ?? null });
    } else throw new Error(`fakeDom: unsupported selector syntax near "${s}" in "${src}"`);
    s = s.slice(m[0].length);
  }
  return c;
}

function parseComplex(src: string): Complex {
  const tokens: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of src.trim()) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (ch === ">" || /\s/.test(ch))) {
      if (cur) tokens.push(cur);
      cur = "";
      if (ch === ">") tokens.push(">");
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  const parts: Complex["parts"] = [];
  let pending: " " | ">" | null = null;
  for (const t of tokens) {
    if (t === ">") {
      pending = ">";
      continue;
    }
    if (parts.length) parts[parts.length - 1]!.combinator = pending ?? " ";
    parts.push({ compound: parseCompound(t), combinator: null });
    pending = null;
  }
  return { parts: parts.reverse() };
}

function parseSelector(selector: string): Complex[] {
  return splitTop(selector, ",").map(parseComplex);
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  if (c.ids.some((id) => el.id !== id)) return false;
  if (c.classes.some((k) => !el.classList.contains(k))) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "|=" && v !== a.value && !v.startsWith(a.value + "-")) return false;
  }
  for (const p of c.pseudos) {
    const sibs = el.parentNode?.children ?? [el];
    switch (p.name) {
      case "not":
        if (p.arg && parseSelector(p.arg).some((cx) => matchesComplex(el, cx))) return false;
        break;
      case "first-child":
        if (sibs[0] !== el) return false;
        break;
      case "last-child":
        if (sibs[sibs.length - 1] !== el) return false;
        break;
      case "checked":
        if (!el.hasAttribute("checked")) return false;
        break;
      case "disabled":
        if (!el.hasAttribute("disabled")) return false;
        break;
      case "scope":
        break;
      default:
        throw new Error(`fakeDom: unsupported pseudo-class :${p.name}`);
    }
  }
  return true;
}

function matchesComplex(el: FakeElement, cx: Complex): boolean {
  const [first, ...rest] = cx.parts;
  if (!first || !matchesCompound(el, first.compound)) return false;
  // parts run right-to-left; each leftward part's `combinator` links it to the
  // part on its right (" " descendant, ">" child). Like the real DOM, ancestor
  // compounds may match outside the element a query was issued on.
  let node: FakeElement | null = el;
  for (const part of rest) {
    node = node!.parentElement;
    if (part.combinator === ">") {
      if (!node || !matchesCompound(node, part.compound)) return false;
    } else {
      while (node && !matchesCompound(node, part.compound)) node = node.parentElement;
      if (!node) return false;
    }
  }
  return true;
}

function matchesParsed(el: FakeElement, sel: Complex[]): boolean {
  return sel.some((cx) => matchesComplex(el, cx));
}

// -- document / window -------------------------------------------------------

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null;
  defaultView: FakeWindow | null = null;
  hidden = false;
  visibilityState: "visible" | "hidden" = "visible";
  baseURI = "https://app.test/";
  fullscreenElement: FakeElement | null = null;
  title = "";

  constructor() {
    super(FakeNode.DOCUMENT_NODE, "#document", null);
    this.ownerDocument = null;
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createElementNS(ns: string | null, tag: string): FakeElement {
    return new FakeElement(tag, this, ns ?? "http://www.w3.org/1999/xhtml");
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data, this);
  }
  createComment(data: string): FakeComment {
    return new FakeComment(data, this);
  }
  createDocumentFragment(): FakeDocumentFragment {
    return new FakeDocumentFragment(this);
  }
  getElementById(id: string): FakeElement | null {
    let found: FakeElement | null = null;
    walkElements(this, (el) => {
      if (!found && el.id === id) found = el;
    });
    return found;
  }
}

/** A `matchMedia` answerer: decide per query (default: nothing matches). */
export type MediaMatcher = (query: string) => boolean;

export class FakeWindow extends FakeEventTarget {
  innerWidth = 1280;
  innerHeight = 800;
  devicePixelRatio = 1;
  mediaMatcher: MediaMatcher = () => false;
  constructor(readonly document: FakeDocument) {
    super();
  }
}

interface ObserverRecord {
  kind: "intersection" | "resize";
  cb: (entries: unknown[], obs: unknown) => void;
  targets: Set<FakeElement>;
  disconnected: boolean;
  options: unknown;
}

export interface FakeDomHandle {
  document: FakeDocument;
  window: FakeWindow;
  /** Pending requestAnimationFrame callbacks. */
  readonly pendingAnimationFrames: number;
  /** Run every queued requestAnimationFrame callback once (those queued while
   * running wait for the next flush). Returns how many ran. */
  flushAnimationFrames(timestampMs?: number): number;
  /** Live IntersectionObserver / ResizeObserver records. */
  observers: ObserverRecord[];
  /** Deliver an IntersectionObserver entry for `el` to every observer watching it. */
  intersect(el: FakeElement, isIntersecting: boolean, ratio?: number): number;
  /** Deliver a ResizeObserver entry for `el` (also updates el.rect). */
  resize(el: FakeElement, width: number, height: number): number;
  /** Restore the globals that installFakeDom replaced. */
  uninstall(): void;
}

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLCanvasElement",
  "HTMLDivElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "HTMLAnchorElement",
  "SVGElement",
  "Text",
  "DocumentFragment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "getComputedStyle",
  "innerWidth",
  "innerHeight",
  "devicePixelRatio",
  "IntersectionObserver",
  "ResizeObserver",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "localStorage",
  "location",
] as const;

/** The one Event subclass behind MouseEvent / PointerEvent / KeyboardEvent / …:
 * it copies its init dict (key, clientX, pointerId, …) onto the event. */
export class FakeUIEvent extends Event {
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init as EventInit);
    for (const [k, v] of Object.entries(init)) {
      if (!["bubbles", "cancelable", "composed"].includes(k)) define(this, k, v);
    }
  }
}

/** In-memory Storage (localStorage stand-in). */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

/** Put a fresh fake document + window on globalThis (see the module doc). */
export function installFakeDom(opts: { mediaMatcher?: MediaMatcher; innerWidth?: number; innerHeight?: number } = {}): FakeDomHandle {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const k of GLOBAL_KEYS) saved.set(k, Object.getOwnPropertyDescriptor(g, k));

  const doc = new FakeDocument();
  const win = new FakeWindow(doc);
  doc.defaultView = win;
  if (opts.mediaMatcher) win.mediaMatcher = opts.mediaMatcher;
  if (opts.innerWidth !== undefined) win.innerWidth = opts.innerWidth;
  if (opts.innerHeight !== undefined) win.innerHeight = opts.innerHeight;

  let rafSeq = 0;
  const raf = new Map<number, (t: number) => void>();
  const observers: ObserverRecord[] = [];

  const makeObserver = (kind: ObserverRecord["kind"]) =>
    class {
      private readonly rec: ObserverRecord;
      constructor(cb: (entries: unknown[], obs: unknown) => void, options?: unknown) {
        this.rec = { kind, cb, targets: new Set(), disconnected: false, options };
        observers.push(this.rec);
      }
      observe(el: FakeElement): void {
        // Like browsers, observing again after disconnect() resumes delivery.
        this.rec.disconnected = false;
        this.rec.targets.add(el);
      }
      unobserve(el: FakeElement): void {
        this.rec.targets.delete(el);
      }
      disconnect(): void {
        this.rec.targets.clear();
        this.rec.disconnected = true;
      }
      takeRecords(): unknown[] {
        return [];
      }
    };

  const winApi: Record<string, unknown> = {
    document: doc,
    requestAnimationFrame: (cb: (t: number) => void) => {
      const id = ++rafSeq;
      raf.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => void raf.delete(id),
    matchMedia: (query: string) => ({
      media: query,
      matches: win.mediaMatcher(query),
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    getComputedStyle: (el: FakeElement) => el.style,
    // Timers delegate at call time so node:test's mock.timers keeps working.
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    setInterval: (...a: Parameters<typeof setInterval>) => setInterval(...a),
    clearInterval: (id: Parameters<typeof clearInterval>[0]) => clearInterval(id),
    IntersectionObserver: makeObserver("intersection"),
    ResizeObserver: makeObserver("resize"),
    location: g["location"] ?? { href: "https://app.test/", hash: "", host: "app.test", protocol: "https:" },
    navigator: g["navigator"],
    performance: g["performance"],
  };
  for (const [k, v] of Object.entries(winApi)) define(win, k, v);

  const ev = FakeUIEvent;
  const values: Record<string, unknown> = {
    window: win,
    document: doc,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLButtonElement: FakeElement,
    HTMLCanvasElement: FakeElement,
    HTMLDivElement: FakeElement,
    HTMLSelectElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLAnchorElement: FakeElement,
    SVGElement: FakeElement,
    Text: FakeText,
    DocumentFragment: FakeDocumentFragment,
    requestAnimationFrame: winApi["requestAnimationFrame"],
    cancelAnimationFrame: winApi["cancelAnimationFrame"],
    matchMedia: winApi["matchMedia"],
    getComputedStyle: winApi["getComputedStyle"],
    IntersectionObserver: winApi["IntersectionObserver"],
    ResizeObserver: winApi["ResizeObserver"],
    MouseEvent: ev,
    PointerEvent: ev,
    KeyboardEvent: ev,
    FocusEvent: ev,
    InputEvent: ev,
    localStorage: g["localStorage"] ?? memoryStorage(),
    location: winApi["location"],
  };
  for (const [k, v] of Object.entries(values)) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true, enumerable: true });
  }
  // Viewport metrics read live from the window, so a test can resize it.
  for (const k of ["innerWidth", "innerHeight", "devicePixelRatio"] as const) {
    Object.defineProperty(g, k, {
      get: () => win[k],
      set: (v: number) => (win[k] = v),
      configurable: true,
      enumerable: true,
    });
  }
  define(win, "localStorage", values["localStorage"]);

  const deliver = (kind: ObserverRecord["kind"], el: FakeElement, entry: Record<string, unknown>): number => {
    let n = 0;
    for (const o of observers) {
      if (o.kind !== kind || o.disconnected || !o.targets.has(el)) continue;
      o.cb([{ target: el, ...entry }], o);
      n++;
    }
    return n;
  };

  return {
    document: doc,
    window: win,
    get pendingAnimationFrames() {
      return raf.size;
    },
    flushAnimationFrames(timestampMs = 0) {
      const batch = [...raf];
      raf.clear();
      for (const [, cb] of batch) cb(timestampMs);
      return batch.length;
    },
    observers,
    intersect(el, isIntersecting, ratio = isIntersecting ? 1 : 0) {
      return deliver("intersection", el, {
        isIntersecting,
        intersectionRatio: ratio,
        boundingClientRect: el.getBoundingClientRect(),
      });
    },
    resize(el, width, height) {
      el.rect = { ...el.rect, width, height };
      return deliver("resize", el, { contentRect: { x: 0, y: 0, width, height } });
    },
    uninstall() {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      }
    },
  };
}

// -- test helpers ---------------------------------------------------------------

/** Dispatch a DOM-ish event of `type` on `el` (bubbling by default), copying
 * `init` (key, clientX, pointerId, …) onto the event. Returns the event. */
export function fire(el: FakeEventTarget | EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const e = new FakeUIEvent(type, { bubbles: true, cancelable: true, ...init });
  (el as FakeEventTarget).dispatchEvent(e);
  return e;
}

/** Set a form control's value the way a user edit would, then fire `input`
 * (and `change` when `commit` is set — a range slider's release). */
export function typeInto(el: FakeElement | HTMLElement, value: string, commit = false): void {
  (el as FakeElement).value = value;
  fire(el as FakeElement, "input");
  if (commit) fire(el as FakeElement, "change");
}

/** Cast a fake element to the DOM type the code under test returns/accepts. */
export function asFake(el: unknown): FakeElement {
  if (!(el instanceof FakeElement)) throw new Error("not a FakeElement (is the fake DOM installed?)");
  return el;
}

/** Visible text of a subtree with runs of whitespace collapsed. */
export function textOf(el: unknown): string {
  return asFake(el).textContent.replace(/\s+/g, " ").trim();
}
