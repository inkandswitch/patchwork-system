// Reads which plugins a package provides, off the main thread. Registering
// them needs only their descriptions (id, type, name, icon…), so this imports
// the package's entry point, keeps what can be cloned from its `plugins`, and
// posts that back. The main thread imports the package (at the same heads)
// only when a plugin is loaded: see `importPluginFromFolderDocUrl`.
//
// Its `import()` of `/<automergeUrl>/…` is served by the service worker that
// controls this worker.

import { importPackageFromFolderDocUrl } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

type DiscoverRequest = {
  type: "discover";
  id: number;
  url: AutomergeUrl;
};

// `load` is a closure and `module` the implementation, so neither can cross to
// the main thread; `import` isn't needed there, as it loads by re-importing.
function toDescriptor(plugin: any): Record<string, unknown> {
  if (!plugin || typeof plugin !== "object") return {};
  const { load, import: _import, module, ...description } = plugin;
  return description;
}

// Only V8 starts a stack with the error's name and message; Safari's and
// Firefox's are frames alone, which on their own say nothing of what failed.
function describe(error: Error): string {
  const heading = String(error);
  if (!error.stack) return heading;
  if (error.stack.startsWith(heading)) return error.stack;
  return `${heading}\n${error.stack}`;
}

function isDiscoverRequest(data: unknown): data is DiscoverRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).type === "discover" &&
    typeof (data as any).id === "number" &&
    typeof (data as any).url === "string"
  );
}

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (!isDiscoverRequest(data)) return;
  const { id, url } = data;

  importPackageFromFolderDocUrl(url)
    .then((mod) => {
      const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
      const descriptors = plugins.map(toDescriptor);
      (self as unknown as Worker).postMessage({
        type: "descriptors",
        id,
        descriptors,
      });
    })
    .catch((error) => {
      (self as unknown as Worker).postMessage({
        type: "error",
        id,
        error: error instanceof Error ? describe(error) : String(error),
      });
    });
});
