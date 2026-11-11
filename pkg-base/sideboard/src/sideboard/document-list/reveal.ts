function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      p.scrollHeight > p.clientHeight
    ) {
      return p;
    }
  }
  return (document.scrollingElement as HTMLElement) ?? document.body;
}

// the same document can appear many times in the tree, so all of its rows
// become selected at once. only scroll if none of them are already on screen.
function selectedItemIsVisible(el: HTMLElement): boolean {
  const container = scrollParent(el);
  const box = container.getBoundingClientRect();
  const selected = container.querySelectorAll<HTMLElement>(
    '.document-list-item[aria-selected="true"]'
  );
  for (const item of selected) {
    const rect = item.getBoundingClientRect();
    if (rect.top >= box.top && rect.bottom <= box.bottom) return true;
  }
  return false;
}

/** Scroll a just-selected row into view, unless a copy of it already is. */
export function revealSelectedRow(el: HTMLElement) {
  if (selectedItemIsVisible(el)) return;
  // @ts-expect-error scrollIntoViewIfNeeded is non-standard
  el.scrollIntoViewIfNeeded?.();
}
