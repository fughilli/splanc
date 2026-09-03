/**
 * About screen (FUG-96) — reachable from the system-wide ⋯ menu. Describes the
 * project, states the license (AGPL-3.0) and copyright, links out to the source
 * and the studio, credits contributors, and gives the open-source licensing
 * disclosures for every third-party dependency the web app ships.
 *
 * Content is static and offline-friendly: no network calls, links open in a new
 * tab. The dependency roster is a hand-maintained list of what actually ships in
 * the bundle (runtime libraries + self-hosted fonts) — keep it in sync when the
 * shipped dependencies in web/package.json or the bundled fonts change.
 */

import { assetUrl } from "../../assetBase";
import { appBuildInfo, buildLabel, commitUrl } from "../../buildInfo";
import { Card } from "../kit";
import { installAboutStyles } from "./about.css";
import type { Router, Screen } from "../app/router";

const GITHUB_URL = "https://github.com/fughilli/splanc";
const STUDIO_URL = "https://fug.studio";
const COPYRIGHT = "© Fughilli Industries, LLC 2026";

/** Which tab the About screen opens on (⋯ menu → "About" vs "Docs"). */
export type AboutTab = "about" | "docs";

// The developer docs (Sphinx) are published alongside the app at /docs/ on every
// origin (Cloudflare + GitHub Pages + PR previews); assetUrl resolves that
// sibling path against the current document, exactly like the wasm bundles.
const DEV_DOCS_PATH = "docs/index.html";
// The user guide (FUG-103) is published at /user-guide/ on every origin, the
// same way — resolved against the current document via assetUrl.
const USER_GUIDE_PATH = "user-guide/index.html";

interface Contributor {
  name: string;
  url: string;
}

const CONTRIBUTORS: Contributor[] = [{ name: "Kevin Balke", url: "https://fughil.li" }];

interface Dependency {
  name: string;
  license: string;
  url?: string;
}

/**
 * Third-party components shipped in the web bundle. Runtime libraries first,
 * then the self-hosted workspace fonts (see kit/fonts.css). Grouped for display.
 */
const DEP_GROUPS: { title: string; note: string; deps: Dependency[] }[] = [
  {
    title: "Libraries",
    note: "Runtime dependencies bundled into the app.",
    deps: [
      {
        name: "@bufbuild/protobuf",
        license: "Apache-2.0",
        url: "https://github.com/bufbuild/protobuf-es",
      },
      { name: "esptool-js", license: "Apache-2.0", url: "https://github.com/espressif/esptool-js" },
      {
        name: "web-serial-polyfill",
        license: "Apache-2.0",
        url: "https://github.com/google/web-serial-polyfill",
      },
    ],
  },
  {
    title: "Fonts",
    note: "Self-hosted typefaces, latin-subset.",
    deps: [
      { name: "Inter", license: "SIL OFL 1.1", url: "https://github.com/rsms/inter" },
      { name: "Open Sans", license: "Apache-2.0", url: "https://github.com/googlefonts/opensans" },
      { name: "Nunito", license: "SIL OFL 1.1", url: "https://github.com/googlefonts/nunito" },
      { name: "IBM Plex Mono", license: "SIL OFL 1.1", url: "https://github.com/IBM/plex" },
      { name: "Fira Code", license: "SIL OFL 1.1", url: "https://github.com/tonsky/FiraCode" },
      {
        name: "Courier Prime",
        license: "SIL OFL 1.1",
        url: "https://github.com/quoteunquoteapps/CourierPrime",
      },
    ],
  },
];

/** An external link that opens safely in a new tab. */
function extLink(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "about-link";
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** The build-info value for a commit: a link to its GitHub commit page, or a
 * plain "unknown" span when the build was made without stamping (dev/tests). */
function buildValue(commit: string, dirty: boolean): HTMLElement {
  if (!commit) {
    const span = document.createElement("span");
    span.className = "about-build-unknown metric";
    span.textContent = "unknown";
    return span;
  }
  const a = extLink(buildLabel(commit, dirty), commitUrl(commit));
  a.classList.add("metric");
  a.title = commit;
  return a;
}

function heading(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "about-heading";
  h.textContent = text;
  return h;
}

function para(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "about-para";
  p.textContent = text;
  return p;
}

export function AboutScreen(_router: Router, initialTab: AboutTab = "about"): Screen {
  installAboutStyles();
  const el = document.createElement("div");
  el.className = "screen screen--about";

  // Wordmark + one-line description (shown above the tabs, on every tab).
  const wordmark = document.createElement("h1");
  wordmark.className = "about-wordmark";
  wordmark.textContent = "Splanc";
  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent = "Map, drive, and animate LED installations from your phone.";

  // Tabs: "About" (project/license/credits) and "Documentation" (links out to
  // the published docs sites). The ⋯ menu's "Docs" entry deep-links to the
  // Documentation tab via ?tab=docs.
  let tab: AboutTab = initialTab;
  const body = document.createElement("div");
  body.className = "about-body";

  const tabs = document.createElement("div");
  tabs.className = "about-tabs";
  const mkTab = (id: AboutTab, label: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "about-tab" + (tab === id ? " on" : "");
    b.textContent = label;
    b.setAttribute("aria-selected", String(tab === id));
    b.addEventListener("click", () => {
      if (tab === id) return;
      tab = id;
      for (const child of Array.from(tabs.children)) {
        const isOn = (child as HTMLElement).textContent === label;
        child.classList.toggle("on", isOn);
        child.setAttribute("aria-selected", String(isOn));
      }
      render();
    });
    return b;
  };
  tabs.append(mkTab("about", "About"), mkTab("docs", "Documentation"));

  const render = (): void => {
    body.replaceChildren(tab === "docs" ? docsBody() : aboutBody());
  };

  el.append(wordmark, tagline, tabs, body);
  render();
  return { el };
}

/** The "Documentation" tab: links to the published docs sites. */
function docsBody(): HTMLElement {
  const frag = document.createElement("div");
  frag.append(
    para("Guides and reference for splanc, published alongside the app:"),
    Card(
      docLink(
        "Developer documentation",
        "Architecture, subsystems, the effects engine, and the design notes " +
          "(the Sphinx site).",
        assetUrl(DEV_DOCS_PATH),
      ),
      docLink(
        "User guide",
        "An interactive, step-by-step guide to mapping and lighting a fixture.",
        assetUrl(USER_GUIDE_PATH),
      ),
    ),
  );
  return frag;
}

/** The "About" tab: project description, links, contributors, and licensing. */
function aboutBody(): HTMLElement {
  const el = document.createElement("div");

  const about = para(
    "Splanc turns a phone into the control surface for addressable-LED art: " +
      "reconstruct a fixture's real-world layout with your camera, then design, " +
      "preview, and stream lighting effects to it in real time.",
  );

  // Links.
  const links = document.createElement("div");
  links.className = "about-links";
  links.append(
    linkRow("Source code", extLink("github.com/fughilli/splanc", GITHUB_URL)),
    linkRow("Studio", extLink("fug.studio", STUDIO_URL)),
    linkRow("Version", textValue(appBuildInfo.version || "unknown")),
    linkRow("Build", buildValue(appBuildInfo.gitCommit, appBuildInfo.gitDirty)),
  );

  // Contributors.
  const contribList = document.createElement("ul");
  contribList.className = "about-contributors";
  for (const c of CONTRIBUTORS) {
    const li = document.createElement("li");
    li.append(c.name, " — ", extLink(prettyHost(c.url), c.url));
    contribList.appendChild(li);
  }

  // License + copyright.
  const license = document.createElement("div");
  license.className = "about-license";
  const licLine = document.createElement("p");
  licLine.className = "about-para";
  licLine.append(
    "Splanc is free and open-source software, released under the ",
    (() => {
      const strong = document.createElement("strong");
      strong.textContent = "GNU Affero General Public License v3.0";
      return strong;
    })(),
    ".",
  );
  const copyright = document.createElement("p");
  copyright.className = "about-copyright";
  copyright.textContent = COPYRIGHT;
  license.append(licLine, copyright);

  // Open-source disclosures.
  const disclosures = document.createElement("div");
  disclosures.className = "about-disclosures";
  disclosures.append(
    para(
      "Splanc is built with, and gratefully acknowledges, the following " +
        "open-source components, each licensed under its own terms:",
    ),
  );
  for (const group of DEP_GROUPS) {
    const g = document.createElement("div");
    g.className = "about-dep-group";
    const gh = document.createElement("h3");
    gh.className = "about-dep-group-title";
    gh.textContent = group.title;
    const gn = document.createElement("p");
    gn.className = "about-dep-note";
    gn.textContent = group.note;
    const list = document.createElement("ul");
    list.className = "about-deps";
    for (const dep of group.deps) {
      const li = document.createElement("li");
      li.className = "about-dep";
      const nameEl = dep.url
        ? extLink(dep.name, dep.url)
        : (() => {
            const s = document.createElement("span");
            s.className = "about-dep-name";
            s.textContent = dep.name;
            return s;
          })();
      const lic = document.createElement("span");
      lic.className = "about-dep-license";
      lic.textContent = dep.license;
      li.append(nameEl, lic);
      list.appendChild(li);
    }
    g.append(gh, gn, list);
    disclosures.appendChild(g);
  }

  el.append(
    Card(about),
    heading("Links"),
    Card(links),
    heading("Contributors"),
    Card(contribList),
    heading("License"),
    Card(license),
    heading("Open-source acknowledgements"),
    Card(disclosures),
  );
  return el;
}

/**
 * A documentation entry: a bold title + one-line description. When `href` is
 * set it's a link (new tab); otherwise it renders as a disabled placeholder with
 * a small badge (e.g. the user guide, landing in FUG-103).
 */
function docLink(
  title: string,
  desc: string,
  href: string | null,
  badge?: string,
): HTMLElement {
  const row = document.createElement(href ? "a" : "div");
  row.className = "about-doc" + (href ? "" : " is-disabled");
  const head = document.createElement("span");
  head.className = "about-doc-title";
  head.textContent = title;
  if (badge) {
    const b = document.createElement("span");
    b.className = "about-doc-badge";
    b.textContent = badge;
    head.appendChild(b);
  }
  const d = document.createElement("span");
  d.className = "about-doc-desc";
  d.textContent = desc;
  row.append(head, d);
  if (href && row instanceof HTMLAnchorElement) {
    row.href = href;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
  }
  return row;
}

/** A label + value row inside the Links card. */
/** A plain (non-link) value span for a link row, e.g. the release version. */
function textValue(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "about-link-value";
  span.textContent = text;
  return span;
}

function linkRow(label: string, value: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "about-link-row";
  const cap = document.createElement("span");
  cap.className = "about-link-label";
  cap.textContent = label;
  row.append(cap, value);
  return row;
}

/** Strip protocol/trailing slash so a URL reads as a bare host for link text. */
function prettyHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
