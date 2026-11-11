/**
 * Keyboard for the document tree, following the ARIA tree pattern:
 *
 * - the tree is one tab stop: exactly one visible row has tabindex=0 (the last
 *   one focused, or the selected one, or the first), every other row has -1
 * - Up/Down move between visible rows, Home/End jump to the first/last
 * - Right on an open folder goes to its first child; Left on a row that isn't
 *   an open folder goes to its parent folder (rows open/close folders
 *   themselves, see item.tsx, and mark the key handled)
 *
 * Everything is looked up inside `tree`, never the whole document, so two
 * lists on one page don't steal each other's focus.
 */
export function createTreeNav(tree: HTMLElement) {
  const ROW = '[role="treeitem"]';
  let current: HTMLElement | null = null;

  const isVisible = (row: HTMLElement) => row.offsetParent !== null;
  const rows = () =>
    [...tree.querySelectorAll<HTMLElement>(ROW)].filter(isVisible);

  function makeStop(row: HTMLElement) {
    if (current === row) return;
    if (current) current.tabIndex = -1;
    row.tabIndex = 0;
    current = row;
  }

  function focusRow(row: HTMLElement | null | undefined) {
    if (!row) return;
    makeStop(row);
    row.focus();
  }

  // Rows mount, unmount, hide and show all the time (folders opening, the
  // filter, big lists streaming in). Whenever the stop is gone, hand it on.
  function ensureStop() {
    if (current?.isConnected && isVisible(current) && current.tabIndex === 0) {
      return;
    }
    if (current?.isConnected) current.tabIndex = -1;
    current = null;
    const visible = rows();
    const next =
      visible.find((row) => row.getAttribute("aria-selected") === "true") ??
      visible[0];
    if (next) makeStop(next);
  }

  function parentRow(row: HTMLElement) {
    const group = row.parentElement?.closest<HTMLElement>('[role="group"]');
    if (!group || !tree.contains(group)) return null;
    return group.parentElement?.querySelector<HTMLElement>(`:scope > ${ROW}`);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    // keys typed into the rename box are for the rename box
    if (target.closest("input, textarea")) return;
    const row = target.closest<HTMLElement>(ROW);
    if (!row || !tree.contains(row)) return;

    const visible = rows();
    const at = visible.indexOf(row);
    let next: HTMLElement | null | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = visible[at + 1];
        break;
      case "ArrowUp":
        next = visible[at - 1];
        break;
      case "Home":
        next = visible[0];
        break;
      case "End":
        next = visible[visible.length - 1];
        break;
      case "ArrowRight":
        if (row.getAttribute("aria-expanded") !== "true") return;
        // the first child is the next visible row, if it's inside this folder
        next = visible[at + 1];
        if (next && parentRow(next) !== row) next = null;
        break;
      case "ArrowLeft":
        next = parentRow(row);
        break;
      default:
        return;
    }
    event.preventDefault();
    focusRow(next);
  }

  function onFocusIn(event: FocusEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>(ROW);
    if (row && tree.contains(row) && row === event.target) makeStop(row);
  }

  const observer = new MutationObserver(ensureStop);
  observer.observe(tree, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-selected"],
  });
  tree.addEventListener("keydown", onKeyDown);
  tree.addEventListener("focusin", onFocusIn);
  ensureStop();

  return () => {
    observer.disconnect();
    tree.removeEventListener("keydown", onKeyDown);
    tree.removeEventListener("focusin", onFocusIn);
  };
}
