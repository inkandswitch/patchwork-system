/**
 * `<patchwork-view>` as a React JSX intrinsic. Types only; opt in with
 * `import type {} from "@inkandswitch/patchwork-elements/react"`.
 */
import type {} from "react";
import type { PatchworkViewAttrs } from "./jsx.js";

declare module "react" {
  export namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > &
        PatchworkViewAttrs;
    }
  }
}

// React also pollutes the global JSX namespace; mirror it for setups
// that read intrinsics from `global.JSX`.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > &
        PatchworkViewAttrs;
    }
  }
}
