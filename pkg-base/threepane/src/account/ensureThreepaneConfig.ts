import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc, ThreepaneConfigDoc, ToolRef, ToolSlot } from "../types";
import {
  DEFAULT_DOCTITLE_TOOLS,
  DEFAULT_TRAY_TOOLS,
  DOCUMENT_LIST_TOOL,
  THREEPANE_CONFIG_VERSION,
} from "../datatypes";
import { loadDatatypeWhenReady } from "./loadDatatypeWhenReady";
import { slotId, uniqueSlots } from "../components/SlotView";

// Title + spacer are intrinsic to the frame's top bar, never configured tools.
const INTRINSIC_DOCTITLE_TOOLS = new Set(["document-title", "spacer"]);

/** The default sidebar widgets for a fresh (or empty) account. */
function defaultSidebarWidgets(rootFolderUrl?: AutomergeUrl): ToolRef[] {
  return rootFolderUrl ? [[DOCUMENT_LIST_TOOL, rootFolderUrl]] : [];
}

/**
 * Bring a config doc made before versioning up to THREEPANE_CONFIG_VERSION:
 * fill in the default document list, tray and doctitle tools it's missing, and
 * drop duplicate tray slots. Runs once per doc. After that the doc is the
 * person's to edit, and anything they remove stays removed.
 */
export function migrateThreepaneConfig(
  doc: ThreepaneConfigDoc,
  rootFolderUrl?: AutomergeUrl
) {
  if ((doc.version ?? 0) >= THREEPANE_CONFIG_VERSION) return;

  if (!doc.sidebar) doc.sidebar = { widgets: [] };
  if (rootFolderUrl && !doc.sidebar.widgets?.length) {
    doc.sidebar.widgets = defaultSidebarWidgets(rootFolderUrl);
  }

  if (!doc.tray) {
    doc.tray = DEFAULT_TRAY_TOOLS.slice();
  } else {
    // Append default tray tools the saved tray is missing, like
    // llm-config-tray. slotId compares across the string and tuple forms.
    const unique = uniqueSlots(doc.tray);
    if (unique.length !== doc.tray.length) doc.tray = unique;
    const present = new Set(doc.tray.map((s) => slotId(s)));
    for (const id of DEFAULT_TRAY_TOOLS) {
      if (!present.has(id)) {
        doc.tray.push(id);
        present.add(id);
      }
    }
  }

  // A doctitle lane that ended up empty (nothing to migrate from the legacy
  // field) gets the defaults rather than a bare top bar.
  if (!doc.doctitle?.tools?.length) {
    doc.doctitle = { ...doc.doctitle, tools: DEFAULT_DOCTITLE_TOOLS.slice() };
  }

  // Can't seed the document list until the account has a root folder, so leave
  // the migration pending and try again on the next mount.
  if (!doc.sidebar.widgets?.length && !rootFolderUrl) return;

  doc.version = THREEPANE_CONFIG_VERSION;
}

/**
 * Lazily create the threepane layout config doc and point `account.tools.threepane`
 * at it, migrating the legacy `account.documentToolbarToolIds` into its
 * `doctitle` lane and seeding the sidebar with a document list pinned to the
 * account's root folder.
 *
 * Defaults are written only when the config doc is created, or once when an
 * older doc is migrated (see `migrateThreepaneConfig`), never on every mount.
 *
 * Non-destructive: the old `documentToolbarToolIds` / `accountSidebarToolId`
 * fields are left untouched so older builds keep working. Run the (separate,
 * opt-in) cleanupLegacyAccountFields script to remove them later.
 */
export async function ensureThreepaneConfig(
  accountHandle: DocHandle<AccountDoc>,
  repo: Repo
) {
  const rootFolderUrl = accountHandle.doc()?.rootFolderUrl;
  const existingConfigUrl = accountHandle.doc()?.tools?.["threepane"];

  if (existingConfigUrl) {
    const configHandle = await repo.find<ThreepaneConfigDoc>(existingConfigUrl);
    if ((configHandle.doc()?.version ?? 0) >= THREEPANE_CONFIG_VERSION) return;
    configHandle.change((doc) => migrateThreepaneConfig(doc, rootFolderUrl));
    return;
  }

  const datatype = await loadDatatypeWhenReady<ThreepaneConfigDoc>(
    "threepane:config"
  );
  if (!datatype) {
    console.warn("frame: threepane:config datatype never registered");
    return;
  }

  // Re-check after the await in case another tab migrated concurrently.
  if (accountHandle.doc()?.tools?.["threepane"]) return;

  const account = accountHandle.doc();

  // doctitle tools migrate as bare ids: the frame always points them at the
  // selected main-view doc, so a slot tuple's docid would be ignored — keep
  // them as plain strings.
  const doctitleTools: ToolSlot[] = (account?.documentToolbarToolIds ?? [])
    .filter((id) => !INTRINSIC_DOCTITLE_TOOLS.has(id));

  const configHandle = await createDocOfDatatype2<ThreepaneConfigDoc>(
    datatype,
    repo
  );
  configHandle.change((doc) => {
    if (doctitleTools.length) doc.doctitle.tools = doctitleTools;
    doc.sidebar.widgets = defaultSidebarWidgets(account?.rootFolderUrl);
    if (!doc.tray) doc.tray = DEFAULT_TRAY_TOOLS.slice();
    // No root folder yet means no document list yet: leave the doc unversioned
    // so the next mount's migration seeds it.
    if (account?.rootFolderUrl) doc.version = THREEPANE_CONFIG_VERSION;
    else delete doc.version;
  });

  accountHandle.change((acc) => {
    if (!acc.tools) acc.tools = {};
    if (!acc.tools["threepane"]) acc.tools["threepane"] = configHandle.url;
  });
}
