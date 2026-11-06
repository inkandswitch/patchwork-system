export * from "./patchwork-view.js";
export * from "./events.js";
export {
  hasActiveAccess,
  publicAccessChanged,
  setPublicAccess,
  type PublicAccess,
} from "./keyhive-access.js";
export type { PatchworkViewAttrs } from "./jsx.js";

// The `<patchwork-view>` JSX intrinsic lives in opt-in entry points, so a
// consumer only needs the framework types it actually uses:
//
//   import type {} from "@inkandswitch/patchwork-elements/react";
//   import type {} from "@inkandswitch/patchwork-elements/solid";
