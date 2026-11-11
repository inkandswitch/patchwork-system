/**
 * Open-tool bridge. Relays `patchwork:open-tool` from the iframe to the host, so
 * a tool in the sandbox can open a host tool like the LLM config tray.
 *
 * The navigation bridge opens documents by url; this opens host components by
 * id. The rest of the detail is passed through for the host tool to read.
 *
 * Protocol:
 *   iframe → host:  { type: "open-tool", detail: { component, ... } }
 */

import { log } from "../log.js";
import { resolveGatedAttribute } from "./gating.js";

/**
 * Host components an isolated tool may open. Each is something the iframe can
 * make appear on the host, so keep it short. "llm-config-tray" is the LLM
 * picker, which has to run on the host because it owns the settings doc and API
 * key.
 */
export const ALLOWED_OPEN_TOOLS = ["llm-config-tray"];

/** The element's `shared-tools` that are in ALLOWED_OPEN_TOOLS. */
export function resolveSharedTools(element: HTMLElement): string[] {
  return resolveGatedAttribute(element, "shared-tools", ALLOWED_OPEN_TOOLS);
}

/**
 * Re-dispatch `open-tool` messages from the iframe as `patchwork:open-tool` on
 * the host element, for components in `allowedComponents`.
 */
export function startHostOpenToolBridge(
  rpcPort: MessagePort,
  hostElement: HTMLElement,
  allowedComponents: string[] = []
): () => void {
  const allowed = new Set(allowedComponents);

  const onMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (msg?.type !== "open-tool") return;

    const detail = msg.detail as { component?: string; [k: string]: unknown };
    const component = detail?.component;
    if (!component || !allowed.has(component)) {
      log(`open-tool rejected: ${component}`);
      return;
    }
    log(`open-tool: ${component}`);

    hostElement.dispatchEvent(
      new CustomEvent("patchwork:open-tool", {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  };

  rpcPort.addEventListener("message", onMessage);

  return () => {
    rpcPort.removeEventListener("message", onMessage);
  };
}
