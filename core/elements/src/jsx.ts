// Discriminated on `component`: absent → legacy mode, present →
// component mode. `url` is forbidden in legacy mode (meaningless
// without `component`); `doc-url` / `tool-id` are allowed in component
// mode as passthrough data for the inner component to read.
type LegacyPatchworkViewAttrs = {
  "doc-url"?: string;
  "tool-id"?: string | null;
  component?: never;
  url?: never;
};

type PatchworkViewComponentAttrs = {
  component: string;
  url?: string;
  "doc-url"?: string;
  "tool-id"?: string | null;
};

/** The attributes `<patchwork-view>` accepts, for JSX intrinsic typings. */
export type PatchworkViewAttrs =
  | LegacyPatchworkViewAttrs
  | PatchworkViewComponentAttrs;
