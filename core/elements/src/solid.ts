/**
 * `<patchwork-view>` as a Solid JSX intrinsic. Types only; opt in with
 * `import type {} from "@inkandswitch/patchwork-elements/solid"`.
 */
import type {} from "solid-js";
import type { PatchworkViewAttrs } from "./jsx.js";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": HTMLAttributes<HTMLElement> & PatchworkViewAttrs;
    }
  }
}
