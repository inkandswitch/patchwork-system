import type { Repo, DocHandle } from "@automerge/automerge-repo/slim";
import type {
  FolderDoc,
  HasPatchworkMetadata,
  UnixFileEntry,
} from "@inkandswitch/patchwork-filesystem";
import type { Landed } from "../dnd/operations.ts";
import { log } from "../dnd/debug.ts";

// text the browser doesn't know is text: .amtext and .knitout come in as
// application/octet-stream (or nothing at all)
const TEXT_EXTENSIONS = new Set([
  "amtext",
  "knitout",
  "k",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "json",
  "jsonc",
  "md",
  "markdown",
  "txt",
  "csv",
  "tsv",
  "html",
  "htm",
  "css",
  "svg",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "sh",
  "py",
  "log",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/ecmascript",
  "application/xml",
  "application/x-sh",
]);

const isTextMimeType = (mimeType: string) => {
  const type = mimeType.split(";")[0].trim();
  return (
    type.startsWith("text/") ||
    TEXT_MIME_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
};

/**
 * Turn files dropped from the operating system into UnixFileEntry documents
 * (with string content if the file is text)
 * and insert them into `folderHandle` at `index`, in the order they were
 * dropped. A file that can't be read is skipped and named in `failed`; the
 * rest still go in.
 */
export async function handleFilesDrop(
  files: Iterable<File>,
  folderHandle: DocHandle<FolderDoc>,
  repo: Repo,
  index: number
): Promise<{ landed: Landed[]; failed: string[] }> {
  const landed: Landed[] = [];
  const failed: string[] = [];
  let at = index;

  for (const file of files) {
    try {
      const nameParts = file.name.split(".");
      const extension = nameParts.length > 1 ? nameParts.pop()! : "";
      const nameWithoutExt = nameParts.join(".");

      const isText =
        isTextMimeType(file.type) ||
        TEXT_EXTENSIONS.has(extension.toLowerCase());
      const content = isText
        ? await file.text()
        : new Uint8Array(await file.arrayBuffer());
      const fallbackMimeType = isText
        ? "text/plain"
        : "application/octet-stream";
      const knownMimeType =
        file.type !== "application/octet-stream" && file.type;

      const handle = await repo.create2<UnixFileEntry & HasPatchworkMetadata>({
        "@patchwork": {
          type: "file",
        },
        content,
        extension,
        mimeType: knownMimeType || fallbackMimeType,
        name: nameWithoutExt,
      });

      // Each file goes after the one before it, so they keep their order.
      const insertAt = Math.min(at, folderHandle.doc()?.docs?.length ?? 0);
      folderHandle.change((folder) => {
        folder.docs.splice(insertAt, 0, {
          url: handle.url,
          name: file.name,
          type: "file",
        });
      });
      landed.push({ folderUrl: folderHandle.url, index: insertAt, url: handle.url });
      at = insertAt + 1;

      log("FileDrop: Created file document:", file.name, handle.url);
    } catch (error) {
      log("FileDrop: Failed to create file document:", error);
      failed.push(file.name);
    }
  }

  return { landed, failed };
}
