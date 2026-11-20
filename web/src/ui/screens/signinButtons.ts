/**
 * The "Continue with Apple" / "Continue with Google" buttons of the Splanc AI
 * credits flow, drawn to the providers' rules:
 *
 * - Apple (Human Interface Guidelines, Sign in with Apple): black with a
 *   white logo on light backgrounds, white with a black logo on dark, the
 *   system font, the logo left of the title, the same size as other sign-in
 *   buttons.
 * - Google in the iOS app: Google's branding guidelines for a custom button
 *   (the full-colour "G" on white, "Continue with Google"). In a browser,
 *   Google Identity Services draws its own button instead
 *   (renderGoogleButton); this one is its loading placeholder.
 *
 * Stacked one per row with the flow's 12 px gaps (owner rule: never cram).
 */

let installed = false;

const APPLE_LOGO =
  '<svg viewBox="0 0 17 20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.6 10.6c0-2.5 2-3.7 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9C3.3 5 1.7 6 .8 7.6c-1.8 3.2-.5 7.8 1.3 10.4.9 1.3 1.9 2.7 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.3.8 1.4 0 2.3-1.3 3.1-2.6 1-1.4 1.4-2.9 1.4-3-.1 0-2.8-1.1-2.8-4.4zM11.1 3.2c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z"/></svg>';

const GOOGLE_LOGO =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';

const CSS = `
.cf-sso { display: flex; flex-direction: column; gap: var(--sp-3); width: 100%; max-width: 400px; }
.cf-sso-btn {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; min-height: 48px; padding: 0 var(--sp-4); box-sizing: border-box;
  border-radius: 24px; cursor: pointer;
  font: 500 1.02rem/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.01em;
}
.cf-sso-btn:disabled { opacity: 0.55; cursor: default; }
.cf-sso-btn svg { width: 18px; height: 18px; flex: none; }
.cf-sso-btn--apple {
  background: #000; color: #fff; border: 1px solid #000;
  background: light-dark(#000, #fff); color: light-dark(#fff, #000); border-color: light-dark(#000, #fff);
}
.cf-sso-btn--apple svg { width: 16px; height: 19px; margin-top: -2px; }
.cf-sso-btn--google {
  background: #fff; color: #1f1f1f; border: 1px solid #747775;
  font-family: Roboto, -apple-system, "Segoe UI", sans-serif;
}
.cf-sso-gis { min-height: 48px; display: flex; justify-content: flex-start; }
.cf-sso-gis:empty::before {
  content: ""; display: block; width: 100%; height: 44px; border-radius: 22px;
  background: var(--surface-2);
}
`;

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}

function make(cls: string, logo: string, label: string, onClick: () => void): HTMLButtonElement {
  install();
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cf-sso-btn ${cls}`;
  b.innerHTML = logo;
  const span = document.createElement("span");
  span.textContent = label;
  b.append(span);
  b.addEventListener("click", onClick);
  return b;
}

export const appleButton = (onClick: () => void, label = "Continue with Apple") => make("cf-sso-btn--apple", APPLE_LOGO, label, onClick);
export const googleButton = (onClick: () => void, label = "Continue with Google") => make("cf-sso-btn--google", GOOGLE_LOGO, label, onClick);

/** The slot Google Identity Services draws its button into (browser path). */
export function googleSlot(): HTMLElement {
  install();
  const d = document.createElement("div");
  d.className = "cf-sso-gis";
  return d;
}

/** The stacked list of sign-in buttons. */
export function ssoList(...items: HTMLElement[]): HTMLElement {
  install();
  const d = document.createElement("div");
  d.className = "cf-sso";
  d.append(...items);
  return d;
}

/** Is the app drawn light right now? (GIS's button theme follows it.) */
export function appIsLight(): boolean {
  if (typeof getComputedStyle !== "function") return false;
  return getComputedStyle(document.documentElement).colorScheme.trim().startsWith("light");
}
