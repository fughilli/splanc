/**
 * Hand the user a generated file. Desktop / Android: a Blob-URL `<a download>`
 * click. iOS (Safari and, especially, the installed home-screen PWA, where
 * blob downloads are unreliable): the Web Share sheet with the file attached,
 * which offers "Save to Files", AirDrop, Mail… Falls back to the anchor when
 * sharing isn't available or fails for any reason but the user cancelling.
 *
 * Call it straight from the click handler (no awaits before it): Safari only
 * allows navigator.share() with fresh user activation.
 */

function isIos(): boolean {
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  return /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
}

function anchorDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in Safari; give it time.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function saveFile(data: Uint8Array | string, name: string, mime: string): Promise<void> {
  const blob = new Blob([data as unknown as BlobPart], { type: mime });
  if (isIos() && typeof File !== "undefined" && typeof navigator.share === "function") {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare?.({ files: [file] }) ?? false) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return; // user cancelled
        // NotAllowedError (activation lost) etc.: fall through to the download.
      }
    }
  }
  anchorDownload(blob, name);
}
