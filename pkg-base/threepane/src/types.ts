import { AutomergeUrl } from "@automerge/automerge-repo/slim";

/**
 * The account document for a Patchwork frame.
 *
 * Scalar configuration (frame/sidebar/toolbar tool ids) is populated eagerly
 * by AccountDatatype.init. Subdocument URLs (rootFolderUrl, moduleSettingsUrl,
 * contactUrl) are optional for accounts created before system initialization
 * owned them.
 */
export type AccountDoc = {
  frameToolId: string;
  /** @deprecated superseded by the threepane config doc's sidebar.widgets */
  accountSidebarToolId?: string;
  /** @deprecated seeds migration into the threepane config doc's doctitle.tools */
  documentToolbarToolIds?: string[];

  rootFolderUrl?: AutomergeUrl;
  moduleSettingsUrl?: AutomergeUrl;
  contactUrl?: AutomergeUrl;

  /**
   * Per-tool config doc urls, keyed by tool id. `tools["threepane"]` points at
   * a ThreepaneConfigDoc holding the sidebar/doctitle layout.
   */
  tools?: Record<string, AutomergeUrl>;

  /**
   * When the module bundles' init scripts (example documents) ran for this
   * account. Set before seeding, so examples are created at most once — a
   * deleted Examples folder stays deleted.
   */
  exampleDocsSeededAt?: number;
};

/**
 * A configured tool slot: which tool, and which document it renders against.
 * The docid is a real pin — every lane renders the tuple's tool against the
 * document the tuple itself names.
 */
export type ToolRef = [toolId: string, docId: AutomergeUrl];

/**
 * One entry in a tool lane (sidebar / doctitle). Either a `[toolId, docId]`
 * tuple rendered as a `patchwork:tool` against the doc the tuple names, or a
 * bare component id rendered as a `patchwork:component` (with no document).
 */
export type ToolSlot = ToolRef | string;

/**
 * The threepane layout config (its own document, referenced from
 * `AccountDoc.tools["threepane"]`). The context sidebar is host chrome and
 * still registry-driven (every `patchwork:component` tagged `"context-tool"`),
 * but the system tray is configured here: `tray` is the explicit list of tools
 * docked at the bottom-left, in order.
 */
export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolSlot[] };
  doctitle: { tools: ToolSlot[] };
  /** The system-tray tools, docked at the frame's bottom-left, in order. */
  tray: ToolSlot[];
  /**
   * Schema version (see THREEPANE_CONFIG_VERSION). Missing on docs made before
   * versioning; those get their defaults backfilled once, then this is set.
   */
  version?: number;
};
