// Package management is whatever is bound at `/packages`: the account's union
// of package folders. This lists it for the ModuleWatcher, and looks each
// package up as a pinned `/@/` URL whose file list covers the whole package.
import {
  isValidAutomergeUrl,
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
  onChange: (entries: PackageEntry[]) => void,
  /** How long the first listing waits for every member before going without the slow ones. */
  { patienceMs = FIRST_LISTING_PATIENCE_MS }: { patienceMs?: number } = {}
): () => void {
  let stopped = false;
  let patient = true;
  const patience = setTimeout(() => {
    patient = false;
    if (!stopped) changed();
  }, patienceMs);
  let members: DocHandle<unknown>[] = [];
  let last: string | undefined;
  let pending: Promise<void> | undefined;

  // Each member is found on its own: one that isn't available yet (or ever)
  // mustn't hold up the others. It's listed once it arrives, and one that
  // couldn't be found is asked for again a while later.
  const found = new Map<AutomergeUrl, DocHandle<unknown>>();
  const finding = new Set<AutomergeUrl>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const find = (url: AutomergeUrl) => {
    if (found.has(url) || finding.has(url)) return;
    finding.add(url);
    repo
      .find<unknown>(url)
      .then(
        (handle) => {
          found.set(url, handle);
        },
        () => {
          const retry = setTimeout(() => {
            retries.delete(retry);
            if (!stopped) changed();
          }, MEMBER_RETRY_MS);
          retries.add(retry);
        }
      )
      .finally(() => {
        finding.delete(url);
        if (!stopped) changed();
      });
  };

  const list = async () => {
    const urls = accountBindings(account.doc()).get("/packages") ?? [];
    for (const url of urls) find(url);
    // The first listing waits a while for every member, so packages don't
    // load in dribs; after that, a member is listed whenever it arrives.
    if (last === undefined && patient && urls.some((url) => finding.has(url))) return;
    const handles = urls.flatMap((url) => {
      const handle = found.get(url);
      return handle ? [handle] : [];
    });
    if (stopped) return;
    for (const member of members) member.off("change", changed);
    members = handles;
    for (const member of members) member.on("change", changed);

    const entries: PackageEntry[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      // The doc and the heads it was read at, together.
      const heads = member.heads();
      const doc = member.view(heads).doc();
      const memberStep = docStep(await idhash(member.documentId), heads);
      const names = new Set<string>();
      for (const child of providerFor(doc)?.list(doc) ?? []) {
        if (!("link" in child)) continue;
        // Only the first of two links with one name in a folder is reachable
        // by that name, so the second would import the first's code.
        if (names.has(child.name)) {
          console.warn(
            `/packages: skipping a second package named ${JSON.stringify(child.name)} in one folder; rename one`
          );
          continue;
        }
        names.add(child.name);
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
    for (const retry of retries) clearTimeout(retry);
    clearTimeout(patience);
  };
}

/** How long the first listing of `/packages` waits for every member folder. */
const FIRST_LISTING_PATIENCE_MS = 3_000;

/** How long before a `/packages` member that couldn't be found is asked for again. */
const MEMBER_RETRY_MS = 10_000;

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
 * package's pinned `/@/` URL, which the ModuleWatcher imports through its
 * package import (in a browser, discovered in the module-loader worker).
 * Anything else goes to `fallback`, which also does the watching.
 */
export function trackPackagesFolder(
  acctHash: Promise<string>,
  entries: () => PackageEntry[],
  fallback: PackageTracker,
  lookUp: (path: string) => Promise<string> = lookUpViaServiceWorker
): PackageTracker {
  // A lookup pins the whole chain, so the URL changes whenever the account or
  // the member folder does. A pinned URL stays valid forever, so keep the one
  // already imported while the package's own step (its heads and list) is
  // the same: a change elsewhere in /packages mustn't reload every package.
  const known = new Map<string, string>();
  const ownStep = (url: string) => new URL(url).pathname.split("/").at(-1);
  return {
    async findLatest(url) {
      const { documentId } = parseAutomergeUrl(url);
      const entry = entries().find(
        (candidate) => parseAutomergeUrl(candidate.url).documentId === documentId
      );
      if (!entry) return fallback.findLatest(url);
      const latest = await lookUp(packageLookupPath(await acctHash, entry));
      const previous = known.get(documentId);
      if (previous && ownStep(previous) === ownStep(latest)) {
        return previous as AutomergeUrl;
      }
      known.set(documentId, latest);
      // Not an automerge URL: the watcher hands it to its package import as it is.
      return latest as AutomergeUrl;
    },
    watch(url, onChange) {
      const documentId = parseAutomergeUrl(url).documentId;
      const isEntry = () =>
        entries().some((entry) => parseAutomergeUrl(entry.url).documentId === documentId);
      // A package that's a branches doc stands for its default branch, whose
      // code changes without the branches doc changing: watch that too, and
      // follow it when the branch is pointed somewhere else.
      let stopped = false;
      let branch: AutomergeUrl | undefined;
      let unwatchBranch = () => {};
      const follow = async () => {
        if (!isEntry()) return;
        let target: AutomergeUrl | undefined;
        try {
          const latest = await fallback.findLatest(url);
          if (isValidAutomergeUrl(latest)) target = bare(latest);
        } catch {
          return; // keep the branch already watched; the next change asks again
        }
        if (stopped) return;
        if (target && parseAutomergeUrl(target).documentId === documentId) target = undefined;
        if (target === branch) return;
        unwatchBranch();
        branch = target;
        unwatchBranch = target ? fallback.watch(target, onChange) : () => {};
      };
      const unwatch = fallback.watch(url, (seen) => {
        void follow();
        onChange(seen);
      });
      void follow();
      return () => {
        stopped = true;
        unwatch();
        unwatchBranch();
      };
    },
  };
}
