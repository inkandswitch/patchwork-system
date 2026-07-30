/**
 * Ambient types for a Patchwork site — reference from vite-env.d.ts:
 *
 *   /// <reference types="@inkandswitch/patchwork/client" />
 *
 * Pulls in patchwork-elements'/-providers' HTMLElementTagNameMap and JSX
 * augmentations, declares the vite `define`s every site gets from the
 * `patchwork()` plugin, and extends ImportMetaEnv with the default-modules
 * env var.
 */
import "@inkandswitch/patchwork-elements";
import "@inkandswitch/patchwork-providers";

declare global {
  const __SITE_TITLE__: string;
  const __STORAGE_PREFIX__: string;

  interface ImportMetaEnv {
    /**
     * Comma-separated list of default tool-manifest sources the shell boots
     * with. Each entry is an `automerge:` URL or a static `modules.json`
     * URL.
     */
    readonly PATCHWORK_SYSTEM_PACKAGE_LIST_URL?: string;
    /**
     * @deprecated Use {@link ImportMetaEnv.PATCHWORK_SYSTEM_PACKAGE_LIST_URL}.
     * Retained for backwards compatibility with existing build configs.
     */
    readonly VITE_DEFAULT_MODULES?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
