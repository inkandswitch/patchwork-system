/**
 * Tools put their automerge identity on the DOM as plain attributes, so any
 * other tool (or the platform) can ask what a node stands for without
 * coupling to it.
 *
 * | Attribute       | Handle kind                          |
 * |-----------------|--------------------------------------|
 * | `doc-url`       | DocHandle (`<patchwork-view>`'s own) |
 * | `data-doc-url`  | DocHandle                            |
 * | `data-ref-url`  | sub-handle                           |
 * | `data-edge-url` | EdgeHandle                           |
 *
 * A node with several uses the first of `data-ref-url`, `data-edge-url`,
 * `data-doc-url`, `doc-url`. `closestHandle` walks ancestors, so transforms
 * can attach anywhere inside an embedded view.
 */

import type { HandleUrl } from "./edge-handle.js";

export interface HandleAttrs {
  docUrlAttr: "doc-url";
  dataDocUrlAttr: "data-doc-url";
  dataRefUrlAttr: "data-ref-url";
  dataEdgeUrlAttr: "data-edge-url";
}

export const HANDLE_ATTRS: HandleAttrs = {
  docUrlAttr: "doc-url",
  dataDocUrlAttr: "data-doc-url",
  dataRefUrlAttr: "data-ref-url",
  dataEdgeUrlAttr: "data-edge-url",
};

/** Read a handle URL directly off an element, without walking ancestors. */
export function handleFromElement(el: Element): HandleUrl | undefined {
  const direct =
    el.getAttribute(HANDLE_ATTRS.dataRefUrlAttr) ??
    el.getAttribute(HANDLE_ATTRS.dataEdgeUrlAttr) ??
    el.getAttribute(HANDLE_ATTRS.dataDocUrlAttr) ??
    el.getAttribute(HANDLE_ATTRS.docUrlAttr);
  return direct ? (direct as HandleUrl) : undefined;
}

/** The nearest handle url on `node` or its ancestors. */
export function closestHandle(node: Node | null): HandleUrl | undefined {
  let el: Element | null =
    node instanceof Element
      ? node
      : ((node && (node.parentElement as Element | null)) ?? null);
  while (el) {
    const found = handleFromElement(el);
    if (found) return found;
    el = el.parentElement;
  }
  return undefined;
}

/**
 * Every handle-carrying element under `root`. `selector` narrows the search;
 * the default finds all four attributes.
 */
export function querySelectorHandles(
  root: ParentNode = document,
  selector: string = `[${HANDLE_ATTRS.docUrlAttr}],[${HANDLE_ATTRS.dataDocUrlAttr}],[${HANDLE_ATTRS.dataRefUrlAttr}],[${HANDLE_ATTRS.dataEdgeUrlAttr}]`
): { element: Element; url: HandleUrl }[] {
  const out: { element: Element; url: HandleUrl }[] = [];
  const elements = Array.from(root.querySelectorAll(selector));
  for (const el of elements) {
    const url = handleFromElement(el);
    if (url) out.push({ element: el, url });
  }
  return out;
}
