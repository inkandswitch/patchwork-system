import debug from "debug";
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import type { AccountDoc } from "../types";
import { loadDatatypeWhenReady } from "./loadDatatypeWhenReady";

const log = debug("patchwork:threepane:examples");

/**
 * Seed a fresh account with example documents by running each static module
 * bundle's generated `init.js` (emitted by that repo's scripts/bundle.mjs next
 * to its modules.json). Every init script receives the same Examples folder
 * handle, so multiple bundles merge their examples into one folder.
 *
 * Runs at most once per account: the account doc's `exampleDocsSeededAt`
 * marker is claimed *before* seeding (a race between two tabs can at worst
 * skip the examples, never duplicate them), and a deleted Examples folder is
 * never recreated. Accounts that already have documents get the marker but no
 * examples — only truly fresh accounts are seeded.
 */
export async function seedExampleDocuments(
  accountHandle: DocHandle<AccountDoc>,
  repo: Repo
) {
  const account = accountHandle.doc();
  if (!account?.rootFolderUrl) {
    log("skipped — account has no rootFolderUrl");
    return;
  }
  if (account.exampleDocsSeededAt) {
    log(
      "skipped — already ran for this account at",
      new Date(account.exampleDocsSeededAt).toISOString()
    );
    return;
  }

  log("claiming marker on account", accountHandle.url);
  accountHandle.change((doc) => {
    if (!doc.exampleDocsSeededAt) doc.exampleDocsSeededAt = Date.now();
  });

  const rootFolder = await repo.find<FolderDoc>(account.rootFolderUrl);
  const existingDocs = rootFolder.doc()?.docs?.length ?? 0;
  if (existingDocs) {
    log(
      `skipped — root folder already has ${existingDocs} doc(s); only fresh accounts are seeded`
    );
    return;
  }

  const gaios = window.location.hostname.includes("gaios");
  const initUrls = gaios ? [] : await bundleInitScriptUrls();
  log(gaios ? "gaios examples" : "bundle init scripts:", initUrls);
  if (!gaios && !initUrls.length) {
    log("skipped — no static module bundles to ask");
    return;
  }

  const folderDatatype = await loadDatatypeWhenReady<FolderDoc>("folder");
  if (!folderDatatype) {
    log("folder datatype never registered; giving up");
    return;
  }
  const folder = await createDocOfDatatype2<FolderDoc>(
    folderDatatype,
    repo,
    (doc) => {
      doc.title = "Examples";
    }
  );

  if (gaios) {
    const { seedGaiosExamples } = await import("./gaiosExamples");
    await seedGaiosExamples(repo, folder);
  }

  for (const url of initUrls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      await mod.default?.(repo, folder);
      log("ran init script", url);
    } catch (err) {
      // A bundle that ships no init script 404s here — normal, not an error.
      log("init script unavailable or failed", url, err);
    }
  }

  const seeded = folder.doc()?.docs?.length ?? 0;
  if (!seeded) {
    // Don't leave an empty Examples folder if no bundle contributed anything.
    log("no bundle contributed any documents");
    return;
  }

  rootFolder.change((doc) => {
    doc.docs.unshift({ name: "Examples", type: "folder", url: folder.url });
  });
  log(`seeded ${seeded} document(s) into Examples folder`, folder.url);
}

type ModuleWatcherLike = {
  urls?: Record<string, string>;
  doneLoading?: Promise<void>;
};

/**
 * The patchwork-tools bundle isn't in every site's default module sources
 * (some boot from an automerge module-settings doc, which has no init.js),
 * but its examples should seed everywhere — so it's always consulted, unless
 * the site asks for only its own examples (see siteExamplesOnly).
 */
const TOOLS_BUNDLE_INIT_URL = "https://patchwork-tools.netlify.app/init.js";

/**
 * Fallback for shells with no static manifest at all (automerge-doc module
 * sources only): the deployed patchwork-base bundle. Not consulted when any
 * static manifest is configured, because that manifest is usually a copy of
 * this very bundle (e.g. a localhost dev serve) and URL-dedupe can't tell —
 * always adding it would seed base's examples twice.
 */
const BASE_BUNDLE_INIT_URL = "https://patchwork-base.netlify.app/init.js";

/**
 * A site that wants only its own examples says so on its root element —
 * `<html data-examples="site">` — and the hardcoded bundles above are left
 * out: just the init.js next to each of its own static manifests runs.
 */
function siteExamplesOnly() {
  return document.documentElement.getAttribute("data-examples") === "site";
}

/**
 * The `init.js` URL next to every static (http) module manifest the host is
 * watching, plus the hardcoded bundles above (unless the site opts out of
 * them). Automerge module-settings docs have no init script. Waits for the
 * watcher's initial load so the bundles' plugins are registered before any
 * example runs.
 */
async function bundleInitScriptUrls(): Promise<string[]> {
  const siteOnly = siteExamplesOnly();
  const watcher = (
    window as { patchwork?: { packages?: ModuleWatcherLike } }
  ).patchwork?.packages;
  if (!watcher?.urls) {
    return siteOnly ? [] : [BASE_BUNDLE_INIT_URL, TOOLS_BUNDLE_INIT_URL];
  }
  await watcher.doneLoading;
  const fromManifests = Object.values(watcher.urls)
    .filter((url) => typeof url === "string" && !url.startsWith("automerge:"))
    .map((url) => new URL("init.js", new URL(url, document.baseURI)).href);
  if (siteOnly) return [...new Set(fromManifests)];
  const base = fromManifests.length ? [] : [BASE_BUNDLE_INIT_URL];
  return [...new Set([...fromManifests, ...base, TOOLS_BUNDLE_INIT_URL])];
}
