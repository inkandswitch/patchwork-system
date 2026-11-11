/**
 * Builds the `srcdoc` HTML string for the isolated iframe — the host-side
 * assembly step. The iframe's runtime code lives in `./iframe-bootstrap.ts` as
 * typed functions (`boot` + its injected helpers); here we serialize them with
 * `.toString()` into the srcdoc's `<script>` and wrap them in the minimal HTML
 * shell (base layout + first-paint theming).
 */

import { boot } from "../iframe/main.js";
import { installLocalStorageStub } from "../iframe/local-storage.js";
import { installFetchProxy } from "../iframe/fetch-proxy.js";
import { installLinkInterception } from "../iframe/link-interception.js";
import { createRpcClient } from "../iframe/rpc.js";
import { createProvidersBridge } from "../iframe/providers-bridge.js";
import { setupEsModuleShims } from "../iframe/es-module-shims.js";
import { createRegistry } from "../iframe/registry.js";
import { createRootComponentData } from "../iframe/root-component-data.js";
import { createDragDrop } from "../iframe/drag-drop.js";

/**
 * The host's current resolved appearance, used to paint the iframe's first
 * frame to match. Both values are resolved browser values (not theming-tool
 * variables/attributes), so this stays independent of any specific theme tool.
 */
export interface IframeAppearance {
  /** Resolved background color to paint before the theme CSS loads. */
  background?: string;
  /** Resolved `color-scheme` (so form controls/scrollbars match immediately). */
  colorScheme?: string;
}

/**
 * Allow only characters that are safe to interpolate into the static srcdoc
 * CSS below. These values come from the host's own computed styles (a resolved
 * `rgb(...)`/`color()` string and a `color-scheme` keyword), not from tools,
 * but we sanitize anyway so nothing can break out of the <style> context.
 */
function cssSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9 #%(),.\-/]/g, "");
}

/**
 * Build the iframe srcdoc. The host's current background and color-scheme are
 * baked into the static markup so the iframe's *first paint* already matches
 * the host — eliminating the flash of white that otherwise shows until the
 * theming tool boots inside the iframe and applies the real theme CSS. This is
 * tool-agnostic: it mirrors whatever the host actually renders, with no
 * knowledge of how (or which tool) produced it.
 */
export function generateIframeSrcdoc(appearance?: IframeAppearance): string {
  const background = appearance?.background ? cssSafe(appearance.background) : "";
  const colorScheme = appearance?.colorScheme
    ? cssSafe(appearance.colorScheme)
    : "";
  const firstPaint =
    background || colorScheme
      ? `\n      ${colorScheme ? `color-scheme: ${colorScheme};` : ""}${
          background ? ` background: ${background};` : ""
        }`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: row;${firstPaint}
    }
    /* Base layout for the platform elements, mirroring the host app shell's
       global.css. Without these, patchwork-view / repo-provider default to
       display:inline inside the iframe and any root that relies on a full-size
       flex/height context (e.g. a frame's document column) collapses. The host
       provides this for free via its site stylesheet; the isolated realm must
       provide it itself since that stylesheet does not cross the boundary. */
    repo-provider {
      flex: 1;
      min-width: 0;
      display: flex;
      width: 100%;
      height: 100%;
    }
    patchwork-view {
      display: block;
      width: 100%;
      height: 100%;
      contain: layout;
    }
  </style>
</head>
<body>
  <script>
    // The iframe script. boot() and its injected code (helpers + RPC client) are
    // defined as typed functions in ../iframe/*.ts and serialized in here via
    // .toString(); they're passed to boot() since they can't close over its scope.
    (${boot.toString()})({
      installLocalStorageStub: ${installLocalStorageStub.toString()},
      installFetchProxy: ${installFetchProxy.toString()},
      installLinkInterception: ${installLinkInterception.toString()},
      createRpcClient: ${createRpcClient.toString()},
      createProvidersBridge: ${createProvidersBridge.toString()},
      setupEsModuleShims: ${setupEsModuleShims.toString()},
      createRegistry: ${createRegistry.toString()},
      createRootComponentData: ${createRootComponentData.toString()},
      createDragDrop: ${createDragDrop.toString()},
    });
  </script>
</body>
</html>`;
}
