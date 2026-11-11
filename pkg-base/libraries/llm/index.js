/**
 * @patchwork/llm — LLM toolkit for Patchwork tools.
 *
 *   import { dom, stream, generate } from "@patchwork/llm"
 *
 *   const el = popup(); root.append(el); el.showPopover()  // framed model picker
 *   const cfg = await el.result                            // null if cancelled
 *   box.append(dom({source, tools}))                       // bare embeddable panel
 *
 *   for await (const ev of stream(messages, { topk: 5 })) {
 *     if (ev.type === "token")      out += ev.delta
 *     if (ev.type === "prediction") showCandidates(ev.candidates) // next-token dist
 *     if (ev.type === "stats")      showStats(ev)                 // ttft, tok/s, decode
 *   }
 *
 *   const { text, stats } = await generate(messages, { onToken, onPrediction })
 *
 * Provider/model/key/temperature live on the account doc (set via popup()/dom()).
 * Telemetry (top-k next-token predictions + decode stats) works for local
 * transformers.js AND OpenRouter.
 */

export {
  // config (account doc + patchwork:llm-config provider)
  readConfig,
  writeConfig,
  callConfig,
  normalizeConfig,
  subscribeConfig,
  resolveConfig,
  ensureSettingsDoc,
  ensureConfig,
  // per-tool / per-doc whole-config overrides
  scopedRaw,
  hasScopeOverride,
  readScopedConfig,
  writeScopeOverride,
  clearScopeOverride,
  settingsDocHandle,
  applyPrompts,
  effectiveSystem,
  DEFAULTS,
  PARAM_KEYS,
  PROVIDER_CAPS,
  TOOL_STORAGE_ID,
  CONFIG_SELECTOR,
  // catalogues / labels
  LOCAL_MODELS,
  WEBLLM_MODELS,
  fetchOpenRouterModels,
  fetchOllamaModels,
  describeConfig,
} from "./config.js";

export {
  generate,
  generateWithTools,
  stream,
  predict,
  scoreTokens,
  preload,
  abort,
  resume,
  onStatus,
  registerLocalModel,
  computeImportance,
  computeAttentionWeights,
  extractFeatures,
  extractCutFeatures,
  decodeTokens,
  probeAttention,
} from "./client.js";

export { dom, popup } from "./picker.js";

export {
  builtinSupported,
  builtinAvailability,
  builtinGenerate,
} from "./builtin.js";

import { CrossOriginWorker as Worker } from "./cross-origin-worker.js";

// Construct this library's compute worker. This has to live in the library:
// `new URL("./worker.js", import.meta.url)` resolves against this module's own
// URL, so it finds the sibling worker.js wherever the library is served from,
// and bundlers only emit the worker chunk when they see this exact literal.
// `Worker` here is CrossOriginWorker.
//
//   import { createWorker } from "@chee/patchwork-llm";
//   const worker = createWorker();
//   worker.onmessage = (e) => console.log(e.data.models);
//   worker.postMessage({ type: "list-local-models" });
export const createWorker = () =>
  new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

// Transport-neutral request preparation, shared by generate() and by
// host-side worker specs that serve this library over a stream.
export {
  prepareGenerate,
  buildGeneratePayload,
  NATIVE_TOOL_PROVIDERS,
  TEMPLATE_TOOL_PROVIDERS,
} from "./request.js";

// LLM tools (user-defined tools the model can be given)
export {
  createLLMTool,
  createToolFile,
  LLMToolDatatype,
  sanitizeToolName,
  resolveTools,
  toToolSchemas,
  buildToolsSystem,
  parseToolCalls,
  loadHandler,
  runTool,
  runHandlerSandboxed,
  // saved prompts (system + pre), same doc shape as tools
  createPromptDoc,
  resolvePromptDocs,
  resolvePromptText,
  resolveCfgPrompts,
  LLMSystemPromptDatatype,
  LLMPrePromptDatatype,
  // folders + one-time migration
  ensureFolderUrl,
  addToFolder,
  removeFromFolder,
  migrateConfig,
} from "./tools.js";

// Registers <patchwork-llm-config-provider> on import.
export {
  PatchworkLLMConfigProvider,
  definePatchworkLLMConfigProvider,
} from "./provider.js";

// Built-in prompt templates
export { PROMPT_TEMPLATES } from "./templates.js";
