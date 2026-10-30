export * from "./patchwork-view.js";
export * from "./events.js";

import type {} from "react";
import type {} from "solid-js";

// Discriminated on `component`: absent → legacy mode, present →
// component mode. `url` is forbidden in legacy mode (meaningless
// without `component`); `doc-url` / `tool-id` are allowed in component
// mode as passthrough data for the inner component to read.
type LegacyPatchworkViewAttrs = {
  "doc-url"?: string;
  "tool-id"?: string | null;
  path?: string | null;
  component?: never;
  url?: never;
};

type PatchworkViewComponentAttrs = {
  component: string;
  url?: string;
  "doc-url"?: string;
  "tool-id"?: string | null;
  path?: string | null;
};

type PatchworkViewAttrs =
  LegacyPatchworkViewAttrs | PatchworkViewComponentAttrs;

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

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": HTMLAttributes<HTMLElement> & PatchworkViewAttrs;
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
