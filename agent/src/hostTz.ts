/**
 * The bridge host's time zone as a POSIX TZ rule (D-562), for the lamps' wall
 * clock (web/src/net/wallClock.ts).
 *
 * First choice: the footer of /etc/localtime (TZif v2+ ends with the zone's
 * POSIX rule on its own line, the rule tzdata itself uses past its tables), so
 * the lamp gets exactly the host's rule. The IANA name comes from the
 * /etc/localtime symlink, else Intl. Fallback (no TZif, a v1 file, an odd
 * footer): the same Intl derivation the app uses.
 */

import { readFileSync, readlinkSync } from "node:fs";
import { parsePosixTz, posixTzFromIntl, type PhoneTz } from "../../web/src/net/posixTz";

/** The POSIX rule in a TZif v2+ file's footer, or null. */
export function tzifFooter(data: Uint8Array): string | null {
  if (data.length < 44 || String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!) !== "TZif") return null;
  if (data[4] === 0) return null; // v1: no footer
  // The footer is "\n<rule>\n" at the very end.
  if (data[data.length - 1] !== 0x0a) return null;
  const end = data.length - 1;
  let start = end - 1;
  while (start >= 0 && data[start] !== 0x0a) start--;
  if (start < 0) return null;
  const rule = new TextDecoder().decode(data.subarray(start + 1, end));
  return rule && parsePosixTz(rule) ? rule : null;
}

/** The IANA name /etc/localtime points at ("Europe/Berlin"), or null. */
function zoneFromLink(path: string): string | null {
  try {
    const target = readlinkSync(path);
    const m = /zoneinfo\/(.+)$/.exec(target);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** The host's zone as a POSIX rule. `path` is for tests. */
export function hostPosixTz(path = "/etc/localtime", nowMs: number = Date.now()): PhoneTz {
  let intlZone = "UTC";
  try {
    intlZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* UTC */
  }
  try {
    const rule = tzifFooter(readFileSync(path));
    if (rule) return { tz: rule, zone: zoneFromLink(path) ?? intlZone, exact: true };
  } catch {
    /* no /etc/localtime: derive */
  }
  try {
    return posixTzFromIntl(intlZone, nowMs);
  } catch {
    return { tz: "UTC0", zone: "UTC", exact: false };
  }
}
