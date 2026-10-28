// Package management is whatever is bound at `/packages`: the account's union
// of package folders. This lists it for the ModuleWatcher, and looks each
// package up as a pinned `/@/` URL whose file list covers the whole package.
import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { PackageTracker } from "./package-tracker.js";
import { docStep, idhash } from "./paths.js";
import { accountBindings, providerFor } from "./providers.js";
import type { AccountNamespaceDoc } from "./types.js";
import { documentBaseOrigin } from "./urls.js";

export type PackageEntry = {
  /** The package doc, without heads. */
  url: AutomergeUrl;
  name: string;
  /** The union member it's in, as a doc step: how a lookup finds it, shadowed or not. */
  memberStep: string;
};

const bare = (url: AutomergeUrl) =>
  stringifyAutomergeUrl({ documentId: parseAutomergeUrl(url).documentId });

/**
 * Watch an account's `/packages` union. `onChange` gets its packages, one per
 * document (the first binding that has it wins), now and whenever the account
 * doc or a member folder changes. Only the account and the member folders are
 * loaded, never the packages.
 */
export function watchPackagesFolder(
  repo: Repo,
  account: DocHandle<AccountNamespaceDoc>,
  onChange: (entries: PackageEntry[]) => void
): () => void {
  let stopped = false;
  let members: DocHandle<unknown>[] = [];
  let last: string | undefined;
  let pending: Promise<void> | undefined;

  const list = async () => {
    const urls = accountBindings(account.doc()).get("/packages") ?? [];
    const handles = (
      await Promise.all(urls.map((url) => repo.find<unknown>(url).catch(() => undefined)))
    ).filter((handle): handle is DocHandle<unknown> => !!handle);
    if (stopped) return;
    for (const member of members) member.off("change", changed);
    members = handles;
    for (const member of members) member.on("change", changed);

    const entries: PackageEntry[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      const doc = member.doc();
      const memberStep = docStep(await idhash(member.documentId), member.heads());
      for (const child of providerFor(doc)?.list(doc) ?? []) {
        if (!("link" in child)) continue;
        const { documentId } = parseAutomergeUrl(child.link);
        if (seen.has(documentId)) continue;
        seen.add(documentId);
        entries.push({ url: bare(child.link), name: child.name, memberStep });
      }
    }
    const key = JSON.stringify(entries);
    if (stopped || key === last) return;
    last = key;
    onChange(entries);
  };

  // Changes arrive in bursts; list once per burst, and once more if one
  // landed while listing.
  let again = false;
  function changed() {
    if (pending) {
      again = true;
      return;
    }
    pending = Promise.resolve()
      .then(list)
      .catch((error) => console.warn("couldn't list /packages", error))
      .finally(() => {
        pending = undefined;
        if (again && !stopped) {
          again = false;
          changed();
        }
      });
  }

  account.on("change", changed);
  changed();
  return () => {
    stopped = true;
    account.off("change", changed);
    for (const member of members) member.off("change", changed);
  };
}

/** The live lookup path for a package: through the member that holds it. */
export function packageLookupPath(acctHash: string, entry: PackageEntry): string {
  return `${acctHash}/packages/${entry.memberStep}/${encodeURIComponent(entry.name)}`;
}

/**
 * Follow a live `/@/` path's redirect to its pinned URL. The service worker
 * keeps the file list the redirect carries.
 */
async function lookUpViaServiceWorker(path: string): Promise<string> {
  const response = await fetch(`${documentBaseOrigin()}/@/${path}`);
  if (!response.ok || !response.redirected) {
    throw new Error(
      `the service worker didn't redirect /@/${path} to a pinned URL (HTTP ${response.status})`
    );
  }
  return response.url;
}

/**
 * A tracker for the packages under `/packages`: `findLatest` answers with the
 * package's pinned `/@/` URL, which the ModuleWatcher imports as an http
 * package. Anything else goes to `fallback`, which also does the watching.
 */
export function trackPackagesFolder(
  acctHash: Promise<string>,
  entries: () => PackageEntry[],
  fallback: PackageTracker,
  lookUp: (path: string) => Promise<string> = lookUpViaServiceWorker
): PackageTracker {
  return {
    async findLatest(url) {
      const { documentId } = parseAutomergeUrl(url);
      const entry = entries().find(
        (candidate) => parseAutomergeUrl(candidate.url).documentId === documentId
      );
      if (!entry) return fallback.findLatest(url);
      // Not an automerge URL: the watcher imports it with importPackageFromHttpUrl.
      return (await lookUp(packageLookupPath(await acctHash, entry))) as AutomergeUrl;
    },
    watch: (url, onChange) => fallback.watch(url, onChange),
  };
}
