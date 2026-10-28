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

/** A package's name: its package.json's, else the doc's title, else its id. */
async function packageName(repo: Repo, url: AutomergeUrl) {
  const handle = await repo.find<Partial<HasPatchworkMetadata> & { title?: string }>(url);
  try {
    const manifest = await resolvePath(repo, handle, ["package.json"]);
    const name = manifest && JSON.parse(decode(manifest.content))?.name;
    if (typeof name === "string" && name) return { handle, name };
  } catch {
    // no package.json, or not JSON: fall back below
  }
  return { handle, name: handle.doc()?.title || handle.documentId };
}

/**
 * Bind `/packages` for an account that has module settings and no packages
 * folder. True if it did. Http entries stay where they are, in module
 * settings, which is still read.
 */
export async function migratePackages(
  repo: Repo,
  account: DocHandle<AccountDoc>
): Promise<boolean> {
  const doc = account.doc();
  if (doc?.namespace?.["/packages"]?.length || !doc?.moduleSettingsUrl) return false;
  const settings = await repo.find<{ modules?: string[] }>(doc.moduleSettingsUrl);
  const seen = new Set<string>();
  const urls = (settings.doc()?.modules ?? []).flatMap((entry) => {
    if (!isValidAutomergeUrl(entry)) return [];
    const { documentId } = parseAutomergeUrl(entry);
    if (seen.has(documentId)) return [];
    seen.add(documentId);
    return [stringifyAutomergeUrl({ documentId })];
  });
  const links = await Promise.all(
    urls.map(async (url) => {
      try {
        const { handle, name } = await packageName(repo, url);
        return [{ name, type: getType(handle.doc() ?? {}) ?? "folder", url }];
      } catch (error) {
        console.warn(`couldn't move package ${url} into /packages`, error);
        return [];
      }
    })
  );
  // Another tab may have migrated while this one read the packages.
  if (account.doc()?.namespace?.["/packages"]?.length) return false;
  const folder = await createSubdoc<{ title: string; docs: unknown[] }>(
    repo,
    "folder",
    (folder) => {
      folder.title = "Packages";
      folder.docs = links.flat();
    }
  );
  account.change((doc) => {
    doc.namespace ??= {};
    doc.namespace["/packages"] = [{ url: folder.url }];
  });
  return true;
}
