import { AutomergeUrl } from "@automerge/automerge-repo/slim";

export type TinyPatchworkLayoutDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;

  frameToolId: string;
  /** @deprecated legacy fields, migrated into the threepane config doc */
  accountSidebarToolId?: string;
  contextToolIds?: string[];
  documentToolbarToolIds?: string[];

  tools?: Record<string, AutomergeUrl>;
};

export type ToolRef = [toolId: string, docId: AutomergeUrl];

/** A doctitle entry: a `[toolId, docId]` tool tuple or a bare component id. */
export type ToolSlot = ToolRef | string;

export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolRef[] };
  doctitle: { tools: ToolSlot[] };
};
