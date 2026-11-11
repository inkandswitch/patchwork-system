// Import/export of `.tldraw` archives (the offline.tldraw.com format).
//
// Import creates a new Patchwork tldraw5 document from the archive; export
// writes the current document back out as an archive.

import { createContext, useContext, type FC, type ReactNode } from "react";
import { useRepo } from "@automerge/automerge-repo-react-hooks";
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import {
  DefaultMainMenu,
  DefaultMainMenuContent,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  useToasts,
  type TLRecord,
  type SerializedStore,
} from "@tldraw/tldraw";
import {
  createDocOfDatatype2,
  getRegistry,
  type DatatypeDescription,
  type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins";

import type { TLDrawDoc } from "./datatype.ts";
import { getTitle } from "./datatype.ts";
import { PATCHWORK_DOC_SHAPE_TYPE } from "./PatchworkDocShape.tsx";

// `tldr-archive` pulls in the SQLite wasm build, so it is only fetched when
// the user actually imports or exports.
const archiveModule = () => import("./tldr-archive.ts");

export const ARCHIVE_EXTENSIONS = [".tldraw", ".tldr"];
const SCRIPT_ENTRY = "main.js";

export function isTldrArchiveFile(file: File) {
  const name = file.name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Creates a new Patchwork document from a `.tldraw` archive, returning its url. */
export async function importArchiveFile(
  file: File,
  repo: Repo
): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { readTldrArchive } = await archiveModule();
  const archive = await readTldrArchive(bytes, baseName(file.name));

  const { extractScriptFiles, storeScriptFiles } = await import("./script.ts");
  const docs = await storeScriptFiles(repo, extractScriptFiles(archive.files));

  const pageId = Object.keys(archive.store).find((id) => id.startsWith("page:"));
  if (pageId) {
    (archive.store as Record<string, { name: string }>)[pageId].name =
      archive.displayName;
  }

  const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
  const datatype = (await registry.load("tldraw5")) as unknown as
    | LoadedDatatype
    | undefined;
  if (!datatype) throw new Error("could not load the tldraw5 datatype");

  // `createDocOfDatatype2` in the installed plugins package is typed against an
  // older @automerge/automerge-repo Repo; cast to bridge the version skew.
  const handle = await (
    createDocOfDatatype2 as (
      d: LoadedDatatype,
      r: unknown,
      change: (doc: TLDrawDoc) => void
    ) => Promise<{ url: string }>
  )(datatype, repo, (doc) => {
    doc.store = archive.store;
    doc.schema = archive.schema;
    doc.docs = docs;
  });

  return handle.url;
}

function baseName(fileName: string) {
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (fileName.toLowerCase().endsWith(ext)) {
      return fileName.slice(0, -ext.length);
    }
  }
  return fileName;
}

export function pickArchiveFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ARCHIVE_EXTENSIONS.join(",");
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

function download(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/zip" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Embedded Patchwork documents have no meaning outside Patchwork, and a store
// containing an unknown shape type fails to load in stock tldraw — so they are
// left out of the archive.
function withoutEmbeddedDocs(store: SerializedStore<TLRecord>) {
  const kept = {} as Record<string, TLRecord>;
  let dropped = 0;
  for (const [id, record] of Object.entries(store) as [string, TLRecord][]) {
    if ((record as { type?: string }).type === PATCHWORK_DOC_SHAPE_TYPE) {
      dropped++;
      continue;
    }
    kept[id] = record;
  }
  return { store: kept as SerializedStore<TLRecord>, dropped };
}

export async function exportDoc(handle: DocHandle<TLDrawDoc>, repo: Repo) {
  const doc = handle.doc();
  if (!doc) throw new Error("document not loaded");

  const snapshot = JSON.parse(JSON.stringify(doc)) as TLDrawDoc;
  const title = getTitle(snapshot) || "Untitled";
  const { store, dropped } = withoutEmbeddedDocs(snapshot.store);

  const scriptFiles = doc.docs?.length
    ? await (await import("./script.ts")).readScriptFiles(repo, doc.docs)
    : undefined;

  const { writeTldrArchive } = await archiveModule();
  const bytes = await writeTldrArchive({
    displayName: title,
    store,
    schema: snapshot.schema,
    scriptFiles,
  });
  download(bytes, `${title}.tldraw`);
  return { dropped };
}

// React 18's types reject tldraw's menu-group return type; it renders fine.
const MenuGroup = TldrawUiMenuGroup as unknown as FC<{
  id: string;
  children?: ReactNode;
}>;

export const TldrFileContext = createContext<{
  handle: DocHandle<TLDrawDoc>;
  element: HTMLElement;
} | null>(null);

export function TldrFileMainMenu() {
  const context = useContext(TldrFileContext);
  const repo = useRepo();
  const { addToast } = useToasts();

  const onImport = async () => {
    try {
      const file = await pickArchiveFile();
      if (!file || !context) return;
      const url = await importArchiveFile(file, repo);
      context.element.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: { url, toolId: "tldraw5" },
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      console.error("[tldraw5] import failed", error);
      addToast({ title: "Import failed", description: String(error) });
    }
  };

  const onExport = async () => {
    try {
      if (!context) return;
      const { dropped } = await exportDoc(context.handle, repo);
      if (dropped > 0) {
        addToast({
          title: "Exported without embedded documents",
          description: `${dropped} embedded Patchwork document${
            dropped === 1 ? "" : "s"
          } left out — stock tldraw can't read them.`,
        });
      }
    } catch (error) {
      console.error("[tldraw5] export failed", error);
      addToast({ title: "Export failed", description: String(error) });
    }
  };

  // `main.js` may sit behind nested folder documents, so finding it is async.
  const docs = context?.handle.doc()?.docs;
  const hasScript = !!docs?.some((link) => link.name === SCRIPT_ENTRY);

  const onOpenScript = async () => {
    if (!context || !docs) return;
    try {
      const { resolveScriptFiles } = await import("./script.ts");
      const url = (await resolveScriptFiles(repo, docs))[SCRIPT_ENTRY];
      if (!url) return;
      context.element.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: { url },
          bubbles: true,
          composed: true,
        })
      );
    } catch (error) {
      console.error("[tldraw5] could not open the script", error);
    }
  };

  return (
    <DefaultMainMenu>
      <MenuGroup id="tldraw-archive">
        {hasScript && (
          <TldrawUiMenuItem
            id="open-tldraw-script"
            label={`Open ${SCRIPT_ENTRY}`}
            readonlyOk
            onSelect={onOpenScript}
          />
        )}
        <TldrawUiMenuItem
          id="import-tldraw-archive"
          label="Import .tldraw file…"
          readonlyOk
          onSelect={onImport}
        />
        <TldrawUiMenuItem
          id="export-tldraw-archive"
          label="Export .tldraw file"
          readonlyOk
          onSelect={onExport}
        />
      </MenuGroup>
      <DefaultMainMenuContent />
    </DefaultMainMenu>
  );
}
