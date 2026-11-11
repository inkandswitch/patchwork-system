/**
 * The running boundary machinery: the intermediary repo, the plugin/module
 * loader, and the host-side bridges (navigation, providers) that relay across
 * the iframe boundary, plus the access-control policy that gates them.
 *
 * This barrel re-exports exactly what the boot sequence (`boot/boot.ts`) wires
 * up. Internal helpers (URL scanning, denylist population, the provider
 * hard-allowlist) stay module-private to their files.
 */

export {
  createIntermediaryRepo,
  SyncAllowlist,
  type IntermediaryRepo,
} from "./repo-bridge.js";
export { startResourceBridge } from "./resource-bridge.js";
export {
  PackagesUrlMapper,
  getRegistries,
  watchRegistries,
} from "./registry-bridge.js";
export {
  buildAllowlist,
  handleAccessRequest,
  requestBridgedUrlAccess,
  allowlistUrlUnlessSensitive,
  getDenylist,
} from "./access-control.js";
export { startHostNavigationBridge } from "./navigation-bridge.js";
export { startHostDragDropBridge } from "./drag-drop-bridge.js";
export { resolveGatedAttribute } from "./gating.js";
export {
  startHostProvidersBridge,
  resolveBridgedProviders,
  makeBridgedValueFilter,
} from "./providers-bridge.js";
export {
  startHostOpenToolBridge,
  resolveSharedTools,
} from "./open-tool-bridge.js";
