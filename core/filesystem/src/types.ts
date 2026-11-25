import type {
  AutomergeUrl,
  ImmutableString,
} from "@automerge/automerge-repo/slim";
import type { HasPatchworkMetadata } from "./metadata.js";

// needed in serviceworker only right now?
// but implied in plugins(?)
export type FolderDoc = {
  title: string;
  docs: DocLink[];
  lastSyncAt?: number; // pushwork sets lastSyncAt when it wants to trigger HMR
};

export type BranchesDoc = HasPatchworkMetadata<"branches"> & {
  branches: { [branchName: string]: AutomergeUrl };
};

// used in serviceworker & datatype
export type DocLink = {
  name: string;
  type: string;
  url: AutomergeUrl;
  icon?: string;
  copyOf?: AutomergeUrl;
};

export type DocPath = DocLink[];

export type UnixFileEntry = {
  content: string | Uint8Array | ImmutableString;
  extension: string;
  mimeType: string;
  name: string;
};

/** One document bound at a mount point. Only automerge documents can be bound. */
export type NamespaceBinding = { url: AutomergeUrl };

/**
 * An account's mount table, after plan9: each mount point is `/` or a top-level `/<name>`, bound
 * to an ordered union of documents. Lookup tries each binding in order; listing concatenates.
 */
export type Namespace = { [mountPoint: string]: NamespaceBinding[] };

/** The parts of an account doc a path walk reads. */
export type AccountNamespaceDoc = HasPatchworkMetadata<"account"> & {
  namespace?: Namespace;
  rootFolderUrl?: AutomergeUrl;
};
