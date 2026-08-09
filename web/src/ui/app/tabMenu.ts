/**
 * Per-tab overflow-menu items. The app-bar ⋯ menu (shell.ts) always shows the
 * app-wide actions (Settings, MIDI, Performance, install); a screen can register
 * context-relevant actions here that the shell renders BELOW a divider — e.g.
 * Maps' import/export, Effects' "send library to debug server".
 *
 * A screen sets its items in `onMount` and clears them (`setTabMenuItems([])`)
 * in `onUnmount`, so leaving the tab drops them.
 */

import type { IconName } from "../kit";

export interface TabMenuItem {
  icon: IconName;
  label: string;
  onClick: () => void;
}

let current: TabMenuItem[] = [];
const listeners = new Set<(items: TabMenuItem[]) => void>();

export function setTabMenuItems(items: TabMenuItem[]): void {
  current = items;
  for (const fn of listeners) fn(current);
}

export function getTabMenuItems(): TabMenuItem[] {
  return current;
}

export function subscribeTabMenu(fn: (items: TabMenuItem[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
