/**
 * Selection + scrolling logic for the Show Mode effects list, kept pure so it
 * unit-tests under Node. The screen owns the DOM; this decides where the
 * highlight goes (encoder ticks, keys, buttons) and how far the list's own
 * scroll container must move to keep it in view, without scrolling the page.
 */

/**
 * Move a highlight by `steps` in a list of `length` items. `wrap` loops past
 * either end (the prev/next buttons); without it the highlight stops at the
 * ends (an encoder spun hard lands on the last item and stays there).
 */
export function stepIndex(index: number, steps: number, length: number, wrap = false): number {
  if (length <= 0) return 0;
  const from = Math.min(Math.max(0, Math.trunc(index)), length - 1);
  const to = from + Math.trunc(steps);
  if (wrap) return ((to % length) + length) % length;
  return Math.min(Math.max(0, to), length - 1);
}

/** What a key press in the list does. */
export type ListKeyAction =
  | { kind: "move"; steps: number }
  | { kind: "jump"; index: number }
  | { kind: "load"; deck: 0 | 1 | "browse" };

/**
 * Keyboard map for the list (a listbox): arrows move one, PageUp/PageDown move
 * a page, Home/End jump, Enter/Space load onto the deck that is browsing,
 * `a`/`b` load onto deck A/B. Returns null for keys the list doesn't handle
 * (so they keep their default behaviour).
 */
export function listKeyAction(key: string, length: number, pageSize: number): ListKeyAction | null {
  const page = Math.max(1, Math.floor(pageSize));
  switch (key) {
    case "ArrowDown":
      return { kind: "move", steps: 1 };
    case "ArrowUp":
      return { kind: "move", steps: -1 };
    case "PageDown":
      return { kind: "move", steps: page };
    case "PageUp":
      return { kind: "move", steps: -page };
    case "Home":
      return { kind: "jump", index: 0 };
    case "End":
      return { kind: "jump", index: Math.max(0, length - 1) };
    case "Enter":
    case " ":
      return { kind: "load", deck: "browse" };
    case "a":
    case "A":
      return { kind: "load", deck: 0 };
    case "b":
    case "B":
      return { kind: "load", deck: 1 };
    default:
      return null;
  }
}

/**
 * The scrollTop that brings an item fully into a scroll container's view,
 * moving as little as possible (`block: "nearest"`), or null if it is already
 * visible. Positions are relative to the container's content box. `margin`
 * keeps a little of the neighbouring rows visible so you can see what's next.
 */
export function scrollTopToReveal(
  view: { scrollTop: number; height: number },
  item: { top: number; height: number },
  margin = 0,
): number | null {
  const top = item.top - margin;
  const bottom = item.top + item.height + margin;
  if (top < view.scrollTop) return Math.max(0, top);
  if (bottom > view.scrollTop + view.height) return Math.max(0, bottom - view.height);
  return null;
}
