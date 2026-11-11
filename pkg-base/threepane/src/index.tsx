import { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc } from "./types";

// WebKit workaround. The registry invokes a tool/component impl the moment its
// `import()` resolves; in Safari that can run the impl's *render* while the
// freshly imported module — and its sibling chunks — still have top-level
// initializers pending, surfacing the first time the frame mounts as
// "Cannot access 'X' before initialization" or "X is undefined" (X has been
// PatchworkFrame, a `_tmpl$` template, and useProviderReady across builds). It
// reproduces under rollup, rolldown AND esbuild, so it's a module-evaluation
// ordering race in the engine, not a bundler bug. A macrotask drains every
// pending microtask — including the module graph's own evaluation
// continuations — so the graph is fully live before we hand back the impl and
// the registry renders it.
function yieldToMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function loadFrame(
  isolation?: boolean
): Promise<ToolImplementation<AccountDoc>> {
  const { renderPatchworkFrame } = await import("./PatchworkFrame");
  await yieldToMacrotask();
  return renderPatchworkFrame(isolation);
}

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:datatype",
    id: "account",
    name: "Patchwork Account",
    icon: "UserCircle",
    unlisted: true,
    async load() {
      const { AccountDatatype } = await import("./datatypes");
      return AccountDatatype;
    },
  },
  {
    type: "patchwork:datatype",
    id: "threepane:config",
    name: "Threepane Config",
    icon: "Settings",
    unlisted: true,
    async load() {
      const { ThreepaneConfigDatatype } = await import("./datatypes");
      return ThreepaneConfigDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "threepane",
    tags: ["frame-tool"],
    name: "Threepane",
    icon: "Window",
    supportedDatatypes: ["account"],
    load: loadFrame,
  },
  {
    type: "patchwork:tool",
    id: "threepane-wild-west",
    tags: ["frame-tool"],
    name: "Threepane",
    icon: "Window",
    supportedDatatypes: ["account"],
    load: loadFrame,
    unlisted: true,
  },
  {
    type: "patchwork:tool",
    id: "threepane-isolation",
    tags: ["frame-tool"],
    name: "Threepane (isolate)",
    icon: "Window",
    supportedDatatypes: ["account"],
    load: () => loadFrame(true),
    unlisted: true,
  },
  {
    // The isolated document-area root mounted inside the iframe by `threepane-isolation`.
    type: "patchwork:component",
    id: "threepane-isolation-root",
    name: "Threepane Isolation Root",
    async load() {
      const { mountIsolationRoot } =
        await import("./components/IsolatedDocumentArea");
      // Same WebKit render-before-init race as loadFrame — this component is
      // mounted the same way (registry invokes it on import resolve).
      await yieldToMacrotask();
      return mountIsolationRoot;
    },
    
  },
  {
    // Back-compat alias: accounts whose frameToolId still points at the old id
    // keep resolving. Unlisted + untagged so it isn't offered as a new option.
    type: "patchwork:tool",
    id: "patchwork-frame",
    name: "Patchwork Frame",
    icon: "Window",
    supportedDatatypes: ["account"],
    unlisted: true,
    load: loadFrame,
  },
]
