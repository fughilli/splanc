/**
 * About-screen styles (FUG-96), injected once (design tokens from kit/tokens.css).
 * Kept as a TS-injected stylesheet so the screen is self-contained and the CSS
 * only touches the DOM at call time (CJS-safe, mirroring settings.css.ts).
 */

let installed = false;

export function installAboutStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--about { padding-bottom: var(--sp-8); }

.about-wordmark {
  font-size: var(--f-display);
  font-weight: 600;
  margin: 0 0 var(--sp-1);
}
.about-tagline {
  color: var(--text-dim);
  margin: 0 0 var(--sp-4);
}
.about-heading {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin: var(--sp-6) 0 var(--sp-2);
}
.about-para { margin: 0 0 var(--sp-2); line-height: 1.5; }
.about-para:last-child { margin-bottom: 0; }

.about-link { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
.about-link:hover { text-decoration: underline; }

.about-links { display: flex; flex-direction: column; gap: var(--sp-3); }
.about-link-row { display: flex; flex-direction: column; gap: 2px; }
.about-link-label {
  font-size: var(--f-caption);
  color: var(--text-dim);
}

.about-contributors { list-style: none; margin: 0; padding: 0; }
.about-contributors li { padding: var(--sp-1) 0; }

.about-license .about-copyright {
  color: var(--text-dim);
  font-size: var(--f-caption);
  margin: var(--sp-2) 0 0;
}

.about-dep-group { margin-top: var(--sp-4); }
.about-dep-group:first-child { margin-top: var(--sp-2); }
.about-dep-group-title {
  font-size: var(--f-body);
  font-weight: 600;
  margin: 0 0 2px;
}
.about-dep-note {
  color: var(--text-dim);
  font-size: var(--f-caption);
  margin: 0 0 var(--sp-2);
}
.about-deps { list-style: none; margin: 0; padding: 0; }
.about-dep {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-1) 0;
  border-top: 1px solid var(--border);
}
.about-dep:first-child { border-top: 0; }
.about-dep-name { overflow-wrap: anywhere; }
.about-dep-license {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: var(--f-caption);
  white-space: nowrap;
}
`;
