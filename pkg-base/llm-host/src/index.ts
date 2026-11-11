import type { Plugin } from "@inkandswitch/patchwork-plugins";

/**
 * The Patchwork side of @chee/patchwork-llm: everything that has to run in the
 * host realm because it touches the settings doc or the API key.
 *
 * Every plugin is behind `load()`, so importing this registers descriptors only.
 * Descriptors must stay plain data: the isolation bridge structured-clones them.
 */
export const plugins: Plugin<any>[] = [
  {
    // System-tray icon that opens the model/config picker. Tools open it with a
    // `patchwork:open-tool` event, which isolation relays to the host.
    type: "patchwork:component",
    id: "llm-config-tray",
    name: "LLM Model & Config",
    icon: "Bot",
    tags: ["system-tray"],
    async load() {
      const { LlmConfigTray } = await import("./LlmConfigTray.js");
      return LlmConfigTray;
    },
  },
  {
    // The serve half, run by the host's worker provider when a tool connects.
    type: "patchwork:worker",
    id: "llm",
    name: "LLM",
    async load() {
      // @ts-ignore — plain-JS library, ships no bundled types
      const lib = await import("@chee/patchwork-llm");
      // @ts-ignore — plain JS
      const { makeLLMWorkerSpec } = await import("./worker-spec.js");
      return makeLLMWorkerSpec(lib);
    },
  },
  {
    // The consume half, resolved by `connectWorkerClient("llm", …)`. Imports
    // nothing, so it's safe to load into a sandbox.
    type: "patchwork:worker-client",
    id: "llm",
    name: "LLM client",
    async load() {
      // @ts-ignore — plain JS
      const { makeLLMClient } = await import("./client.js");
      return makeLLMClient;
    },
  },
];
