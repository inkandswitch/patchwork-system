/**
 * Host-origin `<link>` interception for the sandboxed iframe. Injected into
 * `boot()` and serialized into the srcdoc by ../host/srcdoc.ts (see ./main.ts).
 */

import type { IframeLog } from "./types.js";

/**
 * Intercept host-origin <link> insertions SYNCHRONOUSLY, at insertion time.
 * Native <link> elements make direct browser requests that bypass the fetch
 * proxy and CORS-fail from the opaque origin. Crucially, the browser begins
 * that native request the instant the element is inserted — BEFORE any async
 * MutationObserver callback can run — so we can't fix it after the fact by
 * removing/replacing the node. We intervene before the node enters the DOM, by
 * patching the DOM insertion methods. Two cases, both produced at runtime by
 * code running inside the iframe:
 *
 *  - rel="modulepreload": emitted by bundler runtime (e.g. Vite's
 *    __vitePreload) when a code-split chunk loads. Flip to "modulepreload-shim":
 *    the browser ignores the unknown rel (no native fetch), while es-module-shims
 *    honors it and preloads the chunk through its source hook → our RPC. (The
 *    chunk also loads via the rewritten importShim dynamic import; this just
 *    makes the parallel preload work instead of CORS-failing.)
 *
 *  - rel="stylesheet": emitted by tool code loaded inside isolation that injects
 *    its own host-origin stylesheet <link> at runtime. Substitute a <style>
 *    element in the link's place and fill it by fetching the CSS through the
 *    proxy. The link itself never enters the DOM, so no native request is made.
 *    We map the original link → its <style> so a later link.remove()/removeChild()
 *    also removes the substituted <style>.
 *
 * Must run after `installFetchProxy` — the stylesheet path fetches through the
 * patched global `fetch`.
 */
export function installLinkInterception(hostOrigin: string, log: IframeLog): void {
  const styleForLink = new WeakMap<HTMLLinkElement, HTMLStyleElement>();

  // Returns a replacement node to insert instead of `node`, or `node` itself
  // (possibly mutated) when no substitution is needed.
  const interceptInsertedNode = (node: Node): Node => {
    if (
      !(node instanceof HTMLLinkElement) ||
      !node.href ||
      !node.href.startsWith(hostOrigin)
    ) {
      return node;
    }

    if (node.rel === "modulepreload") {
      log("converted modulepreload → modulepreload-shim:", node.href);
      node.rel = "modulepreload-shim";
      return node;
    }

    if (node.rel === "stylesheet") {
      const href = node.href;
      const style = document.createElement("style");
      // Carry over data-* attributes (some tools key off them).
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith("data-")) {
          style.setAttribute(attr.name, attr.value);
        }
      }
      styleForLink.set(node, style);
      fetch(href)
        .then((r) => r.text())
        .then((css) => {
          style.textContent = css;
        })
        .catch((err) => log("failed to load stylesheet:", href, err));
      log("substituted stylesheet link → style:", href);
      return style;
    }

    return node;
  };

  // Removal: when a substituted stylesheet <link> is removed, also remove the
  // <style> we inserted in its place. The link itself was never inserted (we
  // swapped in the <style>), so for a mapped link we just remove the style and
  // skip the native call (which would throw NotFoundError). For every other
  // node we defer to native behavior unchanged.
  const removeSubstituteStyle = (node: Node): boolean => {
    if (node instanceof HTMLLinkElement) {
      const style = styleForLink.get(node);
      if (style) {
        style.remove();
        styleForLink.delete(node);
        return true;
      }
    }
    return false;
  };

  // Install the prototype patches once. boot() runs a single time per iframe,
  // and the iframe (with these globals) is destroyed wholesale when the host
  // element is torn down — so there is nothing to restore. The guard stops the
  // wrappers stacking if this is ever re-invoked.
  const PATCH_FLAG = "__patchworkDomPatched";
  if (!(Node.prototype as any)[PATCH_FLAG]) {
    (Node.prototype as any)[PATCH_FLAG] = true;

    const patchInsertion = (method: "appendChild" | "insertBefore") => {
      const original = (Node.prototype as any)[method] as (
        ...args: any[]
      ) => Node;
      (Node.prototype as any)[method] = function (
        this: Node,
        ...args: any[]
      ): Node {
        args[0] = interceptInsertedNode(args[0]);
        return original.apply(this, args);
      };
    };
    patchInsertion("appendChild");
    patchInsertion("insertBefore");

    const originalRemoveChild = Node.prototype.removeChild;
    (Node.prototype as any).removeChild = function (
      this: Node,
      child: Node
    ): Node {
      if (removeSubstituteStyle(child)) return child;
      return originalRemoveChild.call(this, child);
    };
    const originalRemove = Element.prototype.remove;
    (Element.prototype as any).remove = function (this: Element): void {
      if (removeSubstituteStyle(this)) return;
      originalRemove.call(this);
    };
  }
}
