import type { Repo } from "@automerge/automerge-repo/slim";
import type {
  LoadablePlugin,
  LoadedPlugin,
  PluginDescription,
} from "./registry/types.js";

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export type DatatypeImplementation<D = unknown> = {
  init(doc: D, repo: Repo): void;
  getTitle(doc: D): string;
  setTitle?(doc: D, title: string): void;
};

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export interface DatatypeDescription extends PluginDescription {
  type: "patchwork:datatype";
  icon: string;
  unlisted?: boolean;
}

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export type Datatype<D = unknown> = LoadablePlugin<
  DatatypeDescription,
  DatatypeImplementation<D>
>;

/** @deprecated Use `packages` from `@inkandswitch/patchwork-filesystem`. */
export type LoadedDatatype<D = unknown> = LoadedPlugin<
  DatatypeDescription,
  DatatypeImplementation<D>
>;
