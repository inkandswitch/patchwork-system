import { type DocHandle, type Repo } from "@automerge/automerge-repo/slim";
import type { FolderDoc } from "./types.js";

/**
 *
 * @param repo an Automerge Repo
 * @param folderHandle the folder handle
 * @param parts the path.split("/")
 */
export async function findHandleInFolderHandle<T>(
  repo: Repo,
  folderHandle: DocHandle<FolderDoc>,
  parts: string[]
) {
  if (!parts.length) return folderHandle;
  const part = parts[0];
  if (!part) return folderHandle;
  const folder = folderHandle.doc();
  if (!folder.docs) return;

  const docLink = folder.docs.find((doc) => doc.name === part);
  if (!docLink) return;

  const docHandle = await repo.find(docLink.url);

  if (parts.length > 1) {
    const doc = docHandle.doc();
    if (!("docs" in doc)) {
      return;
    }
    return findHandleInFolderHandle(
      repo,
      docHandle as DocHandle<FolderDoc>,
      parts.slice(1)
    );
  }
  // todo kind of a lie
  return docHandle as DocHandle<T>;
}
