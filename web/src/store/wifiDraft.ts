/**
 * The Wi-Fi details being typed into the add-device sheet, kept for the session.
 *
 * A mistyped password used to cost the user everything they typed: backing out of
 * the sheet (or waiting out a failed join) and reopening it prefilled from the
 * saved networks, which only gain an entry once a device JOINS. The draft keeps
 * the typed SSID + password so a reopened sheet shows them again.
 *
 * In memory only, on purpose: an unconfirmed (possibly wrong) password is not
 * written to storage; it lives as long as the page (a reload starts over from the
 * saved networks, which `prefs` persists once a join succeeds).
 */

import type { WifiCreds } from "./prefs";

let draft: WifiCreds | null = null;

export const wifiDraft = {
  /** The typed details, or null when nothing was typed this session (or the last
   * provision succeeded). */
  get(): WifiCreds | null {
    return draft ? { ...draft } : null;
  },
  set(creds: WifiCreds): void {
    draft = { ssid: creds.ssid, password: creds.password };
  },
  /** Forget the draft (the network joined and is now a saved network). */
  clear(): void {
    draft = null;
  },
};
