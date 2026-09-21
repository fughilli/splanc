/**
 * Git build info (FUG-126) — the commit + dirty flag the running artifact was
 * built from, surfaced on the About page (this web app's own build) and on the
 * device card (a connected player's firmware build, reported over the wire in
 * `welcome`). Both link to the exact GitHub commit.
 *
 * The web app's own info comes from `__BUILD_INFO__`, which Vite's `define`
 * replaces at bundle time (see vite.config.ts). In the unit-test compile the
 * define isn't applied, so we guard with `typeof` and fall back to an empty
 * (unknown) build.
 */

export interface BuildInfo {
  /** Full 40-char commit hash, or "" when unknown (dev / older firmware). */
  gitCommit: string;
  /** Short hash for display, or "" when unknown. */
  gitCommitShort: string;
  /** Whether the tree had uncommitted changes at build time. */
  gitDirty: boolean;
  /** Release version from the nearest app-v* tag (e.g. "1.2.0"), "0.0.0-dev" for a
   * dev build, or absent for a device whose firmware doesn't report one. */
  version?: string;
}

/** `owner/repo` for GitHub API calls (releases enumeration — see githubReleaseRepo). */
export const REPO_SLUG = "fughilli/splanc";
const REPO_URL = `https://github.com/${REPO_SLUG}`;

/** This web app's own build info (empty when built without --stamp / in tests). */
export const appBuildInfo: BuildInfo =
  typeof __BUILD_INFO__ !== "undefined"
    ? __BUILD_INFO__
    : { gitCommit: "", gitCommitShort: "", gitDirty: false };

/** GitHub commit page for a full commit hash. */
export function commitUrl(commit: string): string {
  return `${REPO_URL}/commit/${commit}`;
}

/** Short label for a build, e.g. "a1b2c3d4 (dirty)" or "unknown". */
export function buildLabel(commit: string, dirty: boolean): string {
  if (!commit) return "unknown";
  const short = commit.slice(0, 8);
  return dirty ? `${short} (dirty)` : short;
}

/** The firmware-build fields the device card renders (FUG-126), computed once so
 * the "Firmware version" + "Firmware build" rows can't drift from each other or
 * from what a test asserts. Empty/absent inputs (older firmware, or a device
 * never yet connected) collapse to the "unknown (connect once)" placeholder the
 * sheet shows before a `welcome` has populated the record. */
export interface FirmwareCardFields {
  /** Release version, or the placeholder when the device hasn't reported one. */
  version: string;
  /** Short build label ("a1b2c3d4 (dirty)"), or the placeholder when unknown. */
  build: string;
  /** GitHub commit link for the build, or null when unknown (render as text). */
  buildUrl: string | null;
  /** Full commit hash for the link tooltip; "" when unknown. */
  commit: string;
}

const FW_UNKNOWN = "unknown (connect once)";

export function firmwareCardFields(dev: {
  fwVersion?: string;
  fwGitCommit?: string;
  fwGitDirty?: boolean;
}): FirmwareCardFields {
  const commit = dev.fwGitCommit ?? "";
  const known = commit.length > 0;
  return {
    version: dev.fwVersion || FW_UNKNOWN,
    build: known ? buildLabel(commit, dev.fwGitDirty ?? false) : FW_UNKNOWN,
    buildUrl: known ? commitUrl(commit) : null,
    commit,
  };
}
