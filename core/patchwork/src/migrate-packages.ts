// Once per account: an account from before `/packages` gets a packages folder
// holding a link to each automerge package its module-settings doc lists,
// bound at `/packages`. The module-settings doc is left as it is: the Packages
// UI still installs into it, and builds before this one still read it.
import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type StorageId,
} from "@automerge/automerge-repo/slim";
import {
  getType,
  resolvePath,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import type { AccountDoc } from "@inkandswitch/patchwork-plugins";
import { createSubdoc } from "./createAccount.js";

const decode = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms)
    ),
  ]);

/** A package's name and type: its package.json's name, else the doc's title. */
async function describePackage(repo: Repo, url: AutomergeUrl) {
  const handle = await repo.find<Partial<HasPatchworkMetadata> & { title?: string }>(url);
  const type = getType(handle.doc() ?? {}) ?? "folder";
  try {
    const manifest = await resolvePath(repo, handle, ["package.json"]);
    const name = manifest && JSON.parse(decode(manifest.content))?.name;
    if (typeof name === "string" && name) return { name, type };
  } catch {
    // no package.json, or not JSON: fall back below
  }
  return { name: handle.doc()?.title || handle.documentId, type };
}

/**
 * Whether `handle` has caught up with every sync server this repo is
 * connected to, waiting up to `timeoutMs`. False when there's no server to
 * ask: offline, the account may be behind another device's.
 */
export async function caughtUpWithServer(
  repo: Repo,
  handle: DocHandle<unknown>,
  timeoutMs = 10_000
): Promise<boolean> {
  if (!repo.isSubductionConnected()) return false;
  const peers = (await repo.connectedSubductionPeerIds()) as StorageId[];
  if (!peers.length) return false;
  const done = () => peers.every((peer) => handle.isCaughtUpWith(peer) === true);
  if (done()) return true;
  return new Promise((resolve) => {
    const finish = (caughtUp: boolean) => {
      clearTimeout(timer);
      handle.off("remote-heads", check);
      handle.off("heads-changed", check);
      resolve(caughtUp);
    };
    const check = () => {
      if (done()) finish(true);
    };
    const timer = setTimeout(() => finish(done()), timeoutMs);
    handle.on("remote-heads", check);
    handle.on("heads-changed", check);
  });
}

/**
 * Bind `/packages` for an account that has module settings and has never
 * had a `/packages` binding (an empty one was emptied on purpose). True if it
 * did.
 *
 * - `caughtUp` is asked first: another device may have migrated already, and
 *   two migrations would each set `/packages`, one losing. If it says no, the
 *   migration waits for a later boot.
 * - A package it can't read is linked under its document id.
 * - Entries pinned to heads, and http entries, stay where they are, in module
 *   settings, which is still read; a `/packages` link would float to latest.
 * - Two packages with one name get distinct names, since only the first of a
 *   name in a folder is reachable by it.
 */
export async function migratePackages(
  repo: Repo,
  account: DocHandle<AccountDoc>,
  options: { caughtUp?: () => Promise<boolean>; readTimeoutMs?: number } = {}
): Promise<boolean> {
  const unmigrated = () => {
    const doc = account.doc();
    return !!doc?.moduleSettingsUrl && !(doc.namespace && "/packages" in doc.namespace);
  };
  if (!unmigrated()) return false;
  if (options.caughtUp && !(await options.caughtUp())) return false;
  if (!unmigrated()) return false;

  const settings = await repo.find<{ modules?: string[] }>(account.doc().moduleSettingsUrl!);
  const seen = new Set<string>();
  const urls = (settings.doc()?.modules ?? []).flatMap((entry) => {
    if (!isValidAutomergeUrl(entry)) return [];
    const { documentId, heads } = parseAutomergeUrl(entry);
    if (heads || seen.has(documentId)) return [];
    seen.add(documentId);
    return [stringifyAutomergeUrl({ documentId })];
  });

  const described = await Promise.all(
    urls.map(async (url) => {
      try {
        return { url, ...(await within(describePackage(repo, url), options.readTimeoutMs ?? 10_000)) };
      } catch (error) {
        console.warn(`linking package ${url} into /packages by its id: couldn't read it`, error);
        return { url, name: parseAutomergeUrl(url).documentId as string, type: "folder" };
      }
    })
  );
  const taken = new Map<string, number>();
  const links = described.map(({ url, name, type }) => {
    const count = (taken.get(name) ?? 0) + 1;
    taken.set(name, count);
    return { name: count === 1 ? name : `${name} (${count})`, type, url };
  });

  // Another tab may have migrated while this one read the packages.
  if (!unmigrated()) return false;
  const folder = await createSubdoc<{ title: string; docs: unknown[] }>(
    repo,
    "folder",
    (folder) => {
      folder.title = "Packages";
      folder.docs = links;
    }
  );
  account.change((doc) => {
    doc.namespace ??= {};
    doc.namespace["/packages"] = [{ url: folder.url }];
  });
  return true;
}
