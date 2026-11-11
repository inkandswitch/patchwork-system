/**
 * Stands up es-module-shims inside the sandboxed iframe. Runs in the sandbox:
 * defined at module scope so tsc checks it, serialized into the srcdoc by
 * ../host/srcdoc.ts, and called from `boot()`.
 *
 * es-module-shims is what lets the iframe load ES modules at all: every import
 * goes through its `source` hook, which fetches the module text over RPC (the
 * iframe can't fetch host-origin URLs directly) and hands it back. `boot()` then
 * drives module loading through the returned `importShim`.
 */

import type { IframeLog } from "./types.js";

export interface ImportShim {
  (specifier: string): Promise<any>;
  addImportMap(map: { imports?: Record<string, string>; scopes?: any }): void;
}

export interface EsModuleShimsConfig {
  /** The es-module-shims source, inlined into a <script> to load the shim. */
  esmsSource: string;
  /** The host's import map, resolved to absolute URLs. */
  importMap?: { imports?: Record<string, string>; scopes?: any };
  /** Fetches a module's source + resolved URL over RPC (see ./rpc.ts). */
  fetchModule: (
    url: string
  ) => Promise<{ source: string; resolvedUrl: string }>;
  log: IframeLog;
}

/**
 * Configure and load es-module-shims, then return its `importShim`. Steps:
 *  1. Set `esmsInitOptions` with a `source` hook that fetches every module over
 *     RPC (and rewrites methods named `import` — see below).
 *  2. Inline the shim source as a <script> and wait a macrotask for it to init.
 *  3. Register the host's import map.
 */
export async function setupEsModuleShims(
  config: EsModuleShimsConfig
): Promise<ImportShim> {
  const { esmsSource, importMap, fetchModule, log } = config;

  // Configure es-module-shims with the source hook before loading it.
  (self as any).esmsInitOptions = {
    shimMode: true,
    async source(
      url: string,
      _fetchOpts: any,
      _parent: string,
      _defaultSource: Function
    ) {
      log("source hook:", url);
      const result = await fetchModule(url);
      // Rewrite class methods literally named `import` to bracket notation.
      // es-module-shims' lexer misreads a method named `import` as a dynamic
      // `import()` expression and throws a parse error. This is a live case,
      // not vestigial: @automerge/automerge-repo/slim's Repo class has an
      // `import(binary, args) { … }` method, and Repo loads into every iframe.
      const source = result.source.replace(
        /^(\s+)import\s*\(([^)]*)\)\s*\{/gm,
        '$1["import"]($2) {'
      );
      return { source, url: result.resolvedUrl, type: "js" };
    },
  };

  // Inline es-module-shims source and wait for initialization.
  const esmsScript = document.createElement("script");
  esmsScript.textContent = esmsSource;
  document.head.appendChild(esmsScript);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const importShim: ImportShim = (self as any).importShim;
  if (!importShim) {
    throw new Error("es-module-shims failed to initialize");
  }

  // Add the host's import map.
  if (importMap) {
    importShim.addImportMap(importMap);
  }
  log("importmap configured");

  return importShim;
}
