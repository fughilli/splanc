/**
 * About screen (FUG-96) — reachable from the system-wide ⋯ menu. Describes the
 * project, states the license (AGPL-3.0, with the wire protocol and
 * TouchDesigner binding carved out under MIT) and copyright, links out to the
 * source and the studio, credits contributors, and gives the open-source licensing
 * disclosures for every third-party dependency the web app ships.
 *
 * Content is static and offline-friendly: no network calls, links open in a new
 * tab. The dependency roster is a hand-maintained list of what actually ships in
 * the bundle (runtime libraries + self-hosted fonts) — keep it in sync when the
 * shipped dependencies in web/package.json or the bundled fonts change.
 */

import { Card } from "../kit";
import { installAboutStyles } from "./about.css";
import type { Router, Screen } from "../app/router";

const GITHUB_URL = "https://github.com/fughilli/splanc";
const STUDIO_URL = "https://fug.studio";
const COPYRIGHT = "© Fughilli Industries, LLC 2026";

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

export function AboutScreen(_router: Router): Screen {
  installAboutStyles();
  const el = document.createElement("div");
  el.className = "screen screen--about";

  // Wordmark + one-line description.
  const wordmark = document.createElement("h1");
  wordmark.className = "about-wordmark";
  wordmark.textContent = "Splanc";
  const tagline = document.createElement("p");
  tagline.className = "about-tagline";
  tagline.textContent = "Map, drive, and animate LED installations from your phone.";

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
  const protoLine = para(
    "Its wire protocol and the TouchDesigner client binding are carved out " +
      "under the permissive MIT License, so anyone can build compatible " +
      "projects against them.",
  );
  const copyright = document.createElement("p");
  copyright.className = "about-copyright";
  copyright.textContent = COPYRIGHT;
  license.append(licLine, protoLine, copyright);

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
    wordmark,
    tagline,
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
  return { el };
}

/** A label + value row inside the Links card. */
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
