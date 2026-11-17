/**
 * Share a generated file, with fallbacks (pure: share / canShare / save injected).
 *
 * Why: Chrome (desktop and Android, incl. installed PWAs / WebAPKs, and
 * Chromium-based Samsung Internet) only shares files whose NAME extension AND
 * MIME type are on a fixed allowlist — audio, image, PDF, video and a few text
 * types (.txt/text/plain, .csv, .html, .css…). `.json`, `.gz`, `application/json`
 * and `application/gzip` are not on it, so the diagnostics archive
 * (`splanc-diagnostics-….json.gz`, application/gzip) is refused by share() with
 * NotAllowedError ("Permission denied") — even where canShare() said yes.
 * Sources: chrome/browser/webshare/share_service_impl.cc (desktop) and
 * components/browser_ui/webshare/android/…/ShareServiceImpl.java (Android):
 * PERMITTED_EXTENSIONS / PERMITTED_MIME_TYPES; the list is also in
 * third_party/blink/renderer/modules/webshare/FILE_TYPES.md.
 *
 * So on Chromium the first file offered is a share-safe variant — the archive's
 * uncompressed JSON as `….json.txt` (text/plain) — and the original follows; on
 * WebKit (iOS / macOS Safari, which share any file type) the original goes first.
 * A refusal that a different file could fix (NotAllowedError / DataError /
 * TypeError) moves to the next candidate; anything else, or running out, saves
 * the file instead and says so. The user cancelling (AbortError) stops quietly.
 */

export interface ShareFile {
  blob: Blob;
  name: string;
  mime: string;
}

/** Errors a different file (name / type) might get past. */
const RETRYABLE = new Set(["NotAllowedError", "DataError", "TypeError"]);

/** "Name: message" of a share() rejection, for the status line + logs. */
export function describeShareError(e: unknown): string {
  if (e && typeof e === "object" && "name" in e) {
    const name = String((e as { name: unknown }).name);
    const message = "message" in e ? String((e as { message: unknown }).message) : "";
    return message ? `${name}: ${message}` : name;
  }
  return String(e);
}

function errorName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
}

/** Chromium's file-share allowlist, by extension (FILE_TYPES.md). */
const CHROMIUM_EXTENSIONS = new Set([
  "avif", "bmp", "css", "csv", "ehtml", "flac", "gif", "htm", "html", "ico", "jfif", "jpeg", "jpg", "m4a", "m4v",
  "mp3", "mp4", "mpeg", "mpg", "oga", "ogg", "ogm", "ogv", "opus", "pdf", "pjp", "pjpeg", "png", "shtm", "shtml",
  "svg", "svgz", "text", "tif", "tiff", "txt", "wav", "weba", "webm", "webp", "xbm",
]);

/** Whether Chromium would let this file through share() (extension check; the
 * MIME is set to match by {@link shareSafe}). */
export function chromiumShareable(name: string): boolean {
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext !== undefined && CHROMIUM_EXTENSIONS.has(ext);
}

/** A Chromium-family browser (Chrome, Edge, Samsung Internet, WebView) — not
 * iOS, where every browser is WebKit. */
export function isChromium(ua: string, brands?: readonly { brand: string }[]): boolean {
  if (/iP(hone|ad|od)/.test(ua)) return false;
  if (brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))) return true;
  return /\bChrome\/|\bChromium\/|\bSamsungBrowser\//.test(ua);
}

/** The share-safe form of a file: `<name>.txt`, text/plain, over `plain` (the
 * uncompressed text) when given, else the same bytes. */
export function shareSafe(file: ShareFile, plain?: Blob): ShareFile {
  const base = plain ? file.name.replace(/\.gz$/i, "") : file.name;
  return { blob: plain ?? file.blob, name: `${base}.txt`, mime: "text/plain" };
}

/** The files to try, in order. */
export function shareCandidates(file: ShareFile, opts: { chromium: boolean; plain?: Blob }): ShareFile[] {
  if (chromiumShareable(file.name) && file.mime.startsWith("text/")) return [file];
  const safe = shareSafe(file, opts.plain);
  return opts.chromium ? [safe, file] : [file, safe];
}

export type ShareOutcome =
  | { kind: "shared"; file: ShareFile; errors: string[] }
  | { kind: "cancelled"; errors: string[] }
  | { kind: "saved"; file: ShareFile; errors: string[] };

export interface ShareDeps {
  share: ((d: ShareData) => Promise<void>) | null;
  canShare: ((d: ShareData) => boolean) | null;
  /** Save the file instead (download / Files). */
  save: (f: ShareFile) => Promise<void>;
  /** Make a File (injectable for Node tests without File). */
  toFile?: (f: ShareFile) => File;
  /** Each refusal, as it happens (console + the app log). */
  onError?: (description: string, f: ShareFile) => void;
}

const defaultToFile = (f: ShareFile): File => new File([f.blob], f.name, { type: f.mime });

/** Try each candidate; save `original` when none can be shared. Call straight
 * from the click handler (share() needs fresh user activation). */
export async function shareWithFallback(
  original: ShareFile,
  candidates: readonly ShareFile[],
  deps: ShareDeps,
): Promise<ShareOutcome> {
  const errors: string[] = [];
  const toFile = deps.toFile ?? defaultToFile;
  if (deps.share) {
    for (const c of candidates) {
      // No `title` with the file: some share targets (and older Chrome builds)
      // treat a title + file share as text, or drop the file.
      const data: ShareData = { files: [toFile(c)] };
      if (deps.canShare && !deps.canShare(data)) {
        errors.push(`${c.name}: canShare() said no`);
        continue;
      }
      try {
        await deps.share(data);
        return { kind: "shared", file: c, errors };
      } catch (e) {
        if (errorName(e) === "AbortError") return { kind: "cancelled", errors };
        const d = describeShareError(e);
        errors.push(`${c.name}: ${d}`);
        deps.onError?.(d, c);
        if (!RETRYABLE.has(errorName(e))) break;
      }
    }
  }
  await deps.save(original);
  return { kind: "saved", file: original, errors };
}

/** The status line for an outcome. */
export function describeShareOutcome(o: ShareOutcome, where: string): string {
  const why = o.errors.length > 0 ? ` (${o.errors.join("; ")})` : "";
  switch (o.kind) {
    case "shared":
      return o.file.mime === "text/plain"
        ? `Shared ${o.file.name} — a plain-text copy of the archive (this browser can't share .gz files).${why}`
        : `Shared ${o.file.name}.${why}`;
    case "cancelled":
      return o.errors.length > 0 ? `Share cancelled.${why}` : "";
    case "saved":
      return `Couldn't open Share${why} — saved ${o.file.name}${where ? ` ${where}` : ""} instead.`;
  }
}
