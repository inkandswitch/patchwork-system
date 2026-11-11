/**
 * Access control for the isolation boundary.
 *
 *  - Allowlist population: one-shot scans of a document's content for automerge
 *    URLs, adding each to the allowlist unless it is sensitive (see
 *    `denylistIfSensitive`).
 *  - Denylist: a shared singleton (`getDenylist`) that blocks sensitive
 *    documents (account doc, module settings, tool source code) from ever
 *    syncing to the iframe. Populated eagerly over the known protected roots at
 *    boot, and lazily extended (by `denylistIfSensitive`) for sensitive docs
 *    discovered later in content. Also watches plugin registries and the
 *    account doc to denylist tool source / the user's settings doc as they
 *    appear. The denylist is a classification *cache*: a sensitive doc is
 *    walked once, then every later check is an O(1) set lookup.
 */

import {
  type AutomergeUrl,
  type DocumentId,
  type Repo,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { getAllRegistries } from "@inkandswitch/patchwork-plugins";
import {
  type FolderDoc,
  type BranchesDoc,
  type HasPatchworkMetadata,
  type ModuleSettingsDoc,
} from "@inkandswitch/patchwork-filesystem";
import { SyncAllowlist, SyncDenylist } from "./repo-bridge.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Allowlist population
// ---------------------------------------------------------------------------

/**
 * Scan a single document's content for automerge URLs and add any new ones to
 * the allowlist (unless they are denylisted or turn out to be sensitive — see
 * {@link checkAndDenylistIfSensitive}).
 *
 * This is a one-shot scan, not a live subscription: it reads the document's
 * current contents once. Callers re-invoke it (via the wrappers below) when
 * they want to pick up newly-referenced URLs — at boot from the root docs, and
 * lazily when an access request arrives for a URL we haven't seen yet.
 *
 * @param isStale - optional guard returning true if the caller has been torn
 *   down (e.g. a newer init epoch started). Checked once after `repo.find`
 *   resolves so we don't mutate a stale allowlist. Omit for lazy re-scans where
 *   staleness doesn't matter.
 */
async function scanDocIntoAllowlist(
  repo: Repo,
  docUrl: AutomergeUrl,
  allowlist: SyncAllowlist,
  denylist: SyncDenylist | undefined,
  isStale?: () => boolean
): Promise<void> {
  try {
    const handle = await repo.find(docUrl);
    if (isStale?.()) return;

    const doc = handle.doc();
    if (!doc) return;

    const urls = new Set<AutomergeUrl>();
    collectAutomergeUrls(doc, urls);
    for (const url of urls) {
      await allowlistUrlUnlessSensitive(repo, url, allowlist, denylist);
    }
    log(`allowlist scanned from ${docUrl}`);
  } catch (err) {
    log(`scanDocIntoAllowlist: failed to scan ${docUrl}`, err);
  }
}

/**
 * Add one already-known automerge URL to the allowlist, unless it is sensitive.
 *
 * This is the single "denylist-check, then add a URL we already hold" step,
 * shared by the content scan ({@link scanDocIntoAllowlist}, which discovers URLs
 * inside a document) and by callers that already have the URL in hand and simply
 * need to disclose it to the iframe under an explicit user gesture (e.g. a
 * drag-and-drop into an isolated tool — see the drag-drop bridge).
 *
 * A URL might point at a sensitive document (the account doc, a branches doc,
 * module settings, tool source). Those are denylisted instead of allowlisted and
 * are never handed to the tool. The denylist takes precedence over any grant.
 *
 * Returns true if the URL is now allowlisted (or already was), false if it was
 * denylisted instead — so a caller building a payload to forward can drop the
 * URLs that didn't survive.
 */
export async function allowlistUrlUnlessSensitive(
  repo: Repo,
  url: AutomergeUrl,
  allowlist: SyncAllowlist,
  denylist: SyncDenylist | undefined
): Promise<boolean> {
  if (allowlist.hasUrl(url)) return true;
  if (denylist && (await denylistIfSensitive(repo, url, denylist))) {
    return false;
  }
  allowlist.add(url);
  log(`allowlisted ${url}`);
  return true;
}

/**
 * Build the document allowlist for one isolation boot: create it, add each
 * root URL (skipping any that turns out to be sensitive — those stay
 * denylisted and are simply never handed to the tool), then transitively scan
 * the roots so everything they reference is allowlisted too.
 *
 * The returned allowlist is what gates the intermediary repo's sync. Later,
 * newly-added references are picked up lazily via `refreshAllowlistFromRoots`.
 *
 * `isStale` stops the (async) scan early if a newer init epoch started; the
 * caller re-checks staleness and discards the result on abort.
 */
export async function buildAllowlist(
  repo: Repo,
  rootUrls: AutomergeUrl[],
  denylist: SyncDenylist,
  isStale: () => boolean
): Promise<SyncAllowlist> {
  const allowlist = new SyncAllowlist();

  for (const url of rootUrls) {
    if (await denylistIfSensitive(repo, url, denylist)) {
      log(`root ${url} is sensitive — denylisted, not allowlisted`);
      continue;
    }
    allowlist.add(url);
    log(`allowlisted root ${url}`);
  }

  await populateAllowlistFromRoots(
    repo,
    rootUrls,
    allowlist,
    denylist,
    isStale
  );
  return allowlist;
}

/**
 * Scan multiple root documents into the allowlist, adding everything they
 * transitively reference. Stops early if `isStale` flips (a newer init epoch
 * started). Used by `buildAllowlist` for the initial boot-time seed.
 */
async function populateAllowlistFromRoots(
  repo: Repo,
  rootUrls: AutomergeUrl[],
  allowlist: SyncAllowlist,
  denylist: SyncDenylist | undefined,
  isStale: () => boolean
): Promise<void> {
  for (const url of rootUrls) {
    await scanDocIntoAllowlist(repo, url, allowlist, denylist, isStale);
    if (isStale()) return;
  }
}

/**
 * Re-scan all root documents and add any newly-referenced automerge URLs to
 * the allowlist. Called lazily (e.g. when an access request arrives) rather
 * than on every change, to catch references the user just added.
 */
async function refreshAllowlistFromRoots(
  repo: Repo,
  rootUrls: AutomergeUrl[],
  allowlist: SyncAllowlist,
  denylist: SyncDenylist | undefined
): Promise<void> {
  for (const url of rootUrls) {
    await scanDocIntoAllowlist(repo, url, allowlist, denylist);
  }
}

/**
 * Decide whether the iframe may access a document that isn't yet on the
 * allowlist — the intermediary repo's `onAccessRequest` gate.
 *
 * Unknown documents are NOT auto-allowlisted; the user is prompted. This is a
 * safe default: it stops a tool from silently gaining access to any URL it
 * constructs. The cost is that documents the iframe itself just created also
 * prompt.
 *
 * TODO: once the Author ID API is available, auto-allowlist unknown documents
 * whose author matches the iframe's assigned author ID (the iframe created
 * them) and continue to prompt for all others.
 *
 * Returns true (and allowlists the doc) if access is granted.
 */
export async function handleAccessRequest(
  repo: Repo,
  rootUrls: AutomergeUrl[],
  allowlist: SyncAllowlist,
  denylist: SyncDenylist,
  documentId: DocumentId
): Promise<boolean> {
  if (repo.handles[documentId]) {
    // Known to the host but not yet allowlisted — the URL may have been added
    // since the initial scan (e.g. the user typed a new reference), so re-scan
    // roots before asking. (Skipped for unknown docs: a root re-scan can't
    // surface a doc the host has never seen, so it would be wasted work.)
    await refreshAllowlistFromRoots(repo, rootUrls, allowlist, denylist);
    if (allowlist.has(documentId)) return true;
  }

  // TODO: remove temp approval
  // const approved = window.confirm(
  //   `A tool wants to access a document:\n\n` +
  //     `Document ID: ${documentId}\n\n` +
  //     `This may be a document the tool just created, or one it is ` +
  //     `trying to open. Allow access?`
  // );
  // if (approved) {
  //   allowlist.addDocumentId(documentId);
  // }
  // return approved;
  allowlist.addDocumentId(documentId);
  return true;
}

/**
 * Decide whether a document URL carried by a bridged provider value may be
 * relayed to the iframe. Like {@link handleAccessRequest} but keyed by URL (the
 * form bridged values carry) and without the silent-vs-prompt policy, which is
 * the provider bridge's concern — this is only reached for provider types that
 * are allowed to prompt.
 *
 * Grants immediately if already allowlisted; otherwise re-scans the roots (the
 * URL may have been referenced since the initial scan) and, failing that,
 * prompts the user. Returns true (and allowlists the URL) if access is granted.
 */
export async function requestBridgedUrlAccess(
  repo: Repo,
  rootUrls: AutomergeUrl[],
  allowlist: SyncAllowlist,
  denylist: SyncDenylist,
  url: AutomergeUrl
): Promise<boolean> {
  if (allowlist.hasUrl(url)) return true;
  // Re-scan root documents in case the URL was referenced recently.
  await refreshAllowlistFromRoots(repo, rootUrls, allowlist, denylist);
  if (allowlist.hasUrl(url)) return true;

  const approved = window.confirm(
    `A bridged provider wants to share a document URL:\n\n` +
      `URL: ${url}\n\n` +
      `Allow access?`
  );
  if (approved) {
    allowlist.add(url);
    return true;
  }
  return false;
}

/**
 * Recursively walks a value and collects all valid automerge URLs found.
 */
function collectAutomergeUrls(value: unknown, urls: Set<AutomergeUrl>): void {
  if (typeof value === "string") {
    if (isValidAutomergeUrl(value)) urls.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAutomergeUrls(item, urls);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>))
      collectAutomergeUrls(v, urls);
  }
}

// ---------------------------------------------------------------------------
// Denylist population
// ---------------------------------------------------------------------------

/** Denylist a FolderDoc and all its child documents. */
async function denylistFolderDoc(
  repo: Repo,
  folderUrl: AutomergeUrl,
  denylist: SyncDenylist
): Promise<void> {
  denylist.add(folderUrl);
  try {
    const handle = await repo.find<FolderDoc>(folderUrl);
    const doc = handle.doc();
    for (const docLink of doc?.docs ?? []) {
      denylist.add(docLink.url);
    }
  } catch (err) {
    log(`denylistFolderDoc: failed to read folder ${folderUrl}`, err);
  }
}

/**
 * Denylist a module entry (either a BranchesDoc or a direct FolderDoc)
 * and all its transitive children.
 */
async function denylistModuleEntry(
  repo: Repo,
  moduleUrl: AutomergeUrl,
  denylist: SyncDenylist
): Promise<void> {
  denylist.add(moduleUrl);
  try {
    const handle = await repo.find<HasPatchworkMetadata>(moduleUrl);
    const doc = handle.doc();
    const type = doc?.["@patchwork"]?.type;

    if (type === "branches") {
      const branchesDoc = doc as unknown as BranchesDoc;
      for (const branchUrl of Object.values(branchesDoc.branches ?? {})) {
        await denylistFolderDoc(repo, branchUrl, denylist);
      }
    } else {
      await denylistFolderDoc(repo, moduleUrl, denylist);
    }
    log(`denylisted module with entry ${moduleUrl}`);
  } catch (err) {
    log(`denylistModuleEntry: failed to read module ${moduleUrl}`, err);
  }
}

/**
 * The set of module-settings document URLs the user currently has, drawn from
 * both sources of truth: the ModuleWatcher's loaded URLs and the account doc's
 * `moduleSettingsUrl` (the user's own bundle, which the bootloader wires into
 * the watcher only lazily — so reading the account doc directly catches it even
 * before the watcher has it). Used both to seed the denylist and to recognize a
 * settings doc on the fly.
 */
function getModuleSettingsUrls(): AutomergeUrl[] {
  const urls = new Set<AutomergeUrl>();
  const moduleWatcher = (window as any).patchwork?.packages;
  if (moduleWatcher?.urls) {
    for (const url of Object.values(moduleWatcher.urls) as AutomergeUrl[]) {
      if (isValidAutomergeUrl(url)) urls.add(url);
    }
  }
  const userSettingsUrl = (window as any).accountDocHandle?.doc()
    ?.moduleSettingsUrl;
  if (userSettingsUrl && isValidAutomergeUrl(userSettingsUrl)) {
    urls.add(userSettingsUrl);
  }
  return [...urls];
}

/** Denylist a module-settings doc and every module entry it references. */
async function denylistModuleSettings(
  repo: Repo,
  settingsUrl: AutomergeUrl,
  denylist: SyncDenylist
): Promise<void> {
  denylist.add(settingsUrl);
  try {
    const handle = await repo.find<ModuleSettingsDoc>(settingsUrl);
    const doc = handle.doc();
    for (const moduleUrl of doc?.modules ?? []) {
      await denylistModuleEntry(repo, moduleUrl, denylist);
    }
  } catch (err) {
    log(`failed to read module settings ${settingsUrl}`, err);
  }
}

/**
 * Eagerly enumerate and denylist the protected set — the documents that must
 * never reach a tool, because access would let it damage the user's whole
 * environment rather than just the documents it was given:
 *
 *  1. Account document — the root of the user's identity/config.
 *  2. Module settings docs — control which tools are installed.
 *  3. Tool/package source code (folder & branches docs reachable from the
 *     module settings, plus every plugin importUrl) — editing another tool's
 *     source could inject code that runs with that tool's access.
 *
 * This is the eager pass over the *known* roots. Sensitive docs that are only
 * discovered later (e.g. referenced deep in user content) are caught lazily by
 * `denylistIfSensitive`, which shares the same recognition logic.
 */
export async function populateDenylist(
  repo: Repo,
  denylist: SyncDenylist
): Promise<void> {
  // 1. Account document
  const accountUrl = (window as any).accountDocHandle?.url;
  if (accountUrl) denylist.add(accountUrl);

  // 2 + 3. Module settings docs (from the watcher and the account doc) and the
  // tool source reachable from each.
  for (const settingsUrl of getModuleSettingsUrls()) {
    await denylistModuleSettings(repo, settingsUrl, denylist);
  }

  // 4. Denylist all plugin importUrls from the registry as a catch-all.
  for (const [, registry] of getAllRegistries()) {
    for (const plugin of registry.all()) {
      const importUrl = (plugin as any).importUrl as string | undefined;
      if (importUrl && isValidAutomergeUrl(importUrl)) {
        await denylistModuleEntry(repo, importUrl as AutomergeUrl, denylist);
      }
    }
  }

  log(`denylist populated with ${denylist.size} documents`);
}

/** Whether two automerge URLs refer to the same document (by documentId). */
function sameDoc(a: AutomergeUrl, b: AutomergeUrl): boolean {
  try {
    return parseAutomergeUrl(a).documentId === parseAutomergeUrl(b).documentId;
  } catch {
    return false;
  }
}

/**
 * The single authority on "is this URL a sensitive document, and if so add it
 * (with its descendants) to the denylist." Used both by the lazy allowlist scan
 * (before allowlisting a content-referenced URL) and by the root-URL gate in
 * the isolation element. Returns true if the document was denylisted (caller
 * must skip allowlisting it).
 *
 * Recognition, cheapest first:
 *  1. Already denylisted — an O(1) set lookup. Once the eager `populateDenylist`
 *     pass has run, the account doc, every module-settings doc, and all
 *     tool-source folder/branches docs are already here, so this short-circuit
 *     catches them with no I/O.
 *  2. The account doc, matched by identity.
 *  3. A module-settings doc, matched by membership in the user's settings set
 *     (covers a settings doc wired in after the eager pass).
 *  4. A branches or module-settings doc, matched by `@patchwork.type` (covers
 *     docs only discovered via content references, not from a known root).
 *
 * Note on folders: a plain tool-source FolderDoc has no distinguishing
 * `@patchwork.type` — it is structurally identical to a user-content folder.
 * It is recognized ONLY by provenance: it was reached from a module-settings
 * doc during a denylist walk and is therefore already in the set (step 1). We
 * deliberately do NOT fingerprint folders by shape, which would wrongly block
 * the user's own content folders.
 */
export async function denylistIfSensitive(
  repo: Repo,
  url: AutomergeUrl,
  denylist: SyncDenylist
): Promise<boolean> {
  // 1. Already known sensitive.
  if (denylist.hasUrl(url)) return true;

  // 2. The account doc, by identity.
  const accountUrl = (window as any).accountDocHandle?.url as
    | AutomergeUrl
    | undefined;
  if (accountUrl && sameDoc(url, accountUrl)) {
    log(`dynamically denylisting account doc: ${url}`);
    denylist.add(url);
    return true;
  }

  // 3. A module-settings doc the user has, by membership.
  if (
    getModuleSettingsUrls().some((settingsUrl) => sameDoc(url, settingsUrl))
  ) {
    log(`dynamically denylisting module settings doc (membership): ${url}`);
    await denylistModuleSettings(repo, url, denylist);
    return true;
  }

  // 4. A branches or module-settings doc discovered via content, by type.
  try {
    const handle = await repo.find<HasPatchworkMetadata>(url);
    const type = handle.doc()?.["@patchwork"]?.type;

    if (type === "branches") {
      log(`dynamically denylisting branches doc: ${url}`);
      await denylistModuleEntry(repo, url, denylist);
      return true;
    }
    if (type === "patchwork:module-settings") {
      log(`dynamically denylisting module settings doc: ${url}`);
      await denylistModuleSettings(repo, url, denylist);
      return true;
    }
  } catch (err) {
    log(`denylistIfSensitive: failed to read ${url}`, err);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Shared denylist singleton
// ---------------------------------------------------------------------------

let sharedDenylist: SyncDenylist | null = null;

/**
 * Get the shared denylist, creating and populating it on first call.
 *
 * This is a deliberate process-lifetime singleton, shared by every isolation
 * instance on the page. The denylisted set — account doc, module settings,
 * tool/package source code — is global and identical for all instances, and
 * the plugin registries it watches are themselves page-global singletons. So a
 * single shared denylist (and its registry listeners, which therefore also
 * live for the page's lifetime and are intentionally never removed) is correct;
 * there is nothing per-instance to scope or tear down.
 */
export function getDenylist(repo: Repo): SyncDenylist {
  if (sharedDenylist) return sharedDenylist;

  const denylist = new SyncDenylist();
  // Assign the singleton before kicking off population so concurrent callers
  // share this instance and its single in-flight populate (via whenReady),
  // rather than re-populating. Record the promise so callers can await it
  // before allowlisting anything (see SyncDenylist.setReady / the boot path).
  sharedDenylist = denylist;
  denylist.setReady(populateDenylist(repo, denylist));

  // Watch for new plugin registrations and denylist their source code.
  for (const [, registry] of getAllRegistries()) {
    registry.on("registered", (plugin: any) => {
      const importUrl = plugin.importUrl as string | undefined;
      if (importUrl && isValidAutomergeUrl(importUrl)) {
        void denylistModuleEntry(repo, importUrl as AutomergeUrl, denylist);
      }
    });
  }

  // The user's own module-settings doc is wired into the ModuleWatcher lazily
  // (the bootloader adds it when it appears on the account doc), so the eager
  // populate above can miss it. Watch the account doc and denylist that
  // settings doc (and its tool source) when it first appears, then stop. This
  // mirrors the bootloader's own wireModuleSettingsWhenReady.
  const accountHandle = (window as any).accountDocHandle;
  if (accountHandle) {
    const onChange = () => {
      const settingsUrl = accountHandle.doc()?.moduleSettingsUrl;
      if (settingsUrl && isValidAutomergeUrl(settingsUrl)) {
        accountHandle.off?.("change", onChange);
        void denylistModuleSettings(
          repo,
          settingsUrl as AutomergeUrl,
          denylist
        );
      }
    };
    onChange();
    if (!accountHandle.doc()?.moduleSettingsUrl) {
      accountHandle.on?.("change", onChange);
    }
  }

  return denylist;
}
