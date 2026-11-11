import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";
import { decodeHeads, type UrlHeads } from "@automerge/automerge-repo/slim";
import {
  RepoContext,
  useDocHandle,
  useDocument,
  useRepo,
} from "@automerge/automerge-repo-react-hooks";
import {
  Tldraw,
  useEditor,
  getMediaAssetInfoPartial,
  atom,
  createShapeId,
  type VecLike,
  type TLContent,
  type TLAssetId,
  type TLAsset,
  type TLComponents,
  type TLRecord,
  type TLShapeId,
  type TLStoreWithStatus,
} from "@tldraw/tldraw";
import {
  useAutomergeStore,
  useAutomergePresence,
  useClearHistoryOnScopeSwap,
  useIsHandleReadOnly,
} from "./lith/useAutomergeStore.ts";
import type { TLDrawDoc } from "./datatype.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnixFileEntry } from "@inkandswitch/patchwork-filesystem";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";
import { useSubscribe } from "@inkandswitch/patchwork-providers-react";
import { createRoot } from "react-dom/client";
import { diffStore, type ShapeDiff } from "./diff.ts";
import {
  DiffShapeWrapper,
  DiffStatusContext,
  type DiffStatus,
  type DiffStatusAtom,
} from "./DiffShapeWrapper.tsx";
import {
  PatchworkDocShapeUtil,
  PATCHWORK_DOC_SHAPE_TYPE,
  getDefaultToolId,
} from "./PatchworkDocShape.tsx";
import {
  NewDocShapeTool,
  NewDocToolbar,
  newDocUiOverrides,
  setNewDocToolContext,
} from "./NewDocTool.tsx";
import { isPatchworkDrag, parseDroppedDocs } from "./dnd.ts";
import { ContactCollaboratorCursor } from "./CollaboratorCursor.tsx";

export { splitPresenceUserId } from "./CollaboratorCursor.tsx";

// Custom shapes / tools that let a tldraw canvas embed other Patchwork
// documents. These must be registered both on the Automerge-backed store (so
// the shape type persists) and on the <Tldraw> component (so it renders).
const customShapeUtils = [PatchworkDocShapeUtil];
const customTools = [NewDocShapeTool];

// Diff baseline (fork-point heads) served by the draft overlay
// (`draft:baseline`). `heads` is `null` when there is no baseline and no
// diff is rendered (e.g. on "main"). It is `null` rather than optional so the
// value is a valid structured-cloneable `JSONValue` crossing the provider
// channel.
type Baseline = { heads: UrlHeads | null };

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

function extensionForMimeType(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || mimeType.split("/")[1] || "bin";
}

interface ContactDoc {
  type: string;
  name?: string;
  color?: string;
}

function useContactInfo() {
  const repo = useRepo();
  const [contactUrl, setContactUrl] = useState<AutomergeUrl | undefined>();

  useEffect(() => {
    const accountDocHandle = (window as any).accountDocHandle as
      | DocHandle<{ contactUrl: AutomergeUrl }>
      | undefined;
    if (!accountDocHandle) return;
    const doc = accountDocHandle.doc();
    if (doc?.contactUrl) {
      setContactUrl(doc.contactUrl);
    }
  }, []);

  const [contactDoc] = useDocument<ContactDoc>(contactUrl);

  return {
    // Compose userId as `${contactUrl}-${repo.peerId}` to uniquely identify a session;
    // this prevents tldraw from hiding local cursors across multiple sessions under the same account.
    userId: contactUrl ? `${contactUrl}-${repo.peerId}` : repo.peerId,
    name: contactDoc?.name ?? "Anonymous",
    // The color chosen in the account picker; it rides along in our presence
    // record, so the cursor arrow always matches the contact-cursor token.
    color: contactDoc?.color,
  };
}

export function TldrawTool({
  docUrl,
  element,
}: {
  docUrl: AutomergeUrl;
  element: HTMLElement;
}) {
  const handle = useDocHandle<TLDrawDoc>(docUrl, { suspense: true });
  // A history-pinned handle is at fixed heads and rejects writes, so the whole
  // tool renders read-only. Tracked live: it flips in place when the handle's
  // backing is swapped.
  const readOnly = useIsHandleReadOnly(handle);
  const contactInfo = useContactInfo();
  const store = useAutomergeStore({
    handle,
    userId: contactInfo.userId,
    readOnly,
    shapeUtils: customShapeUtils,
  });

  useAutomergePresence({
    handle: handle as DocHandle<any>,
    store,
    userMetadata: contactInfo,
    element,
  });

  const baseline = useSubscribe<Baseline>(
    element,
    { type: "draft:baseline", url: docUrl },
    { heads: null }
  );
  const diff = useShapeDiff(handle, baseline.heads ?? undefined);

  // Per-tool atom feeding `DiffShapeWrapper` (read via `useValue`). Created once
  // per mount so multiple tldraw tools don't share styling state.
  const [statusAtom] = useState<DiffStatusAtom>(() =>
    atom("diff status", new Map<TLShapeId, DiffStatus>())
  );
  useEffect(() => {
    statusAtom.set(buildStatusMap(diff));
  }, [diff, statusAtom]);

  // Deleted shapes are gone from the live store, so re-insert them as locked
  // ghosts (styled `tl-diff-deleted`). They never reach Automerge — see
  // `useDeletedGhosts`.
  useDeletedGhosts(store, handle, diff);

  const components = useMemo<TLComponents>(
    () => ({
      ShapeWrapper: DiffShapeWrapper,
      Toolbar: NewDocToolbar,
      CollaboratorCursor: ContactCollaboratorCursor,
    }),
    []
  );

  return (
    <DiffStatusContext.Provider value={statusAtom}>
      <Tldraw
        inferDarkMode
        autoFocus
        store={store}
        shapeUtils={customShapeUtils}
        tools={customTools}
        overrides={newDocUiOverrides}
        components={components}
      >
        <TldrawInner docUrl={docUrl} element={element} readOnly={readOnly} />
      </Tldraw>
    </DiffStatusContext.Provider>
  );
}

// Recomputes the diff against `heads` on every doc change. `baseline.heads`
// only moves when the draft is forked (copy-on-write), so without listening to
// the handle the diff would freeze after the first computation. The bump is
// deferred to a microtask so we never recompute synchronously from inside the
// sync layer's own `handle.change` callback.
function useShapeDiff(
  handle: DocHandle<TLDrawDoc>,
  heads: UrlHeads | undefined
): ShapeDiff | null {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let scheduled = false;
    const onChange = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        setTick((t) => t + 1);
      });
    };
    handle.on("change", onChange);
    return () => {
      handle.off("change", onChange);
    };
  }, [handle]);

  return useMemo(() => {
    if (!heads) return null;
    const doc = handle.doc();
    if (!doc) return null;
    try {
      return diffStore(doc, decodeHeads(heads));
    } catch (error) {
      console.warn("[tldraw4/diff] failed to compute diff", error);
      return null;
    }
    // `tick` is intentionally a dependency: it forces recompute on doc change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, heads, tick]);
}

function buildStatusMap(diff: ShapeDiff | null): Map<TLShapeId, DiffStatus> {
  const map = new Map<TLShapeId, DiffStatus>();
  if (!diff) return map;
  for (const id of diff.added) map.set(id, "added");
  for (const id of diff.changed) map.set(id, "changed");
  for (const record of diff.deleted) map.set(record.id as TLShapeId, "deleted");
  return map;
}

// Renders deleted shapes by putting their baseline records back into the
// *tldraw* store as locked ghosts. These are applied via `mergeRemoteChanges`
// (source: "remote"), and the only TLStore->Automerge sync path listens for
// source: "user" — so ghosts never sync back to the doc. `diffStore` reads the
// Automerge doc (not the tldraw store), so ghosts also never re-enter the diff.
function useDeletedGhosts(
  store: TLStoreWithStatus,
  handle: DocHandle<TLDrawDoc>,
  diff: ShapeDiff | null
) {
  const ghostIds = useRef<Set<TLShapeId>>(new Set());

  useEffect(() => {
    const inner = store.store;
    if (!inner) return;

    const desired = new Map<TLShapeId, TLRecord>();
    if (diff) {
      for (const record of diff.deleted) {
        desired.set(record.id as TLShapeId, record);
      }
    }

    // A ghost is only safe to remove if it isn't currently a real record in the
    // doc: if a deleted shape was re-added upstream, the sync layer puts the
    // real record back at the same id, and removing it then would drop the real
    // shape from the view.
    const liveStore = (handle.doc()?.store ?? {}) as Record<string, unknown>;
    const toRemove = [...ghostIds.current].filter(
      (id) => !desired.has(id) && !(id in liveStore)
    );
    const toAdd: TLRecord[] = [];
    for (const [id, record] of desired) {
      if (!ghostIds.current.has(id)) {
        // Fade the ghost via tldraw's first-class `opacity` prop. tldraw writes
        // `opacity` as an inline style on the shape element (Shape.tsx), so a CSS
        // class (`.tl-diff-deleted`) can't override it — the fade has to live on
        // the record itself. The red "removed" glow stays in CSS as a `filter`.
        toAdd.push({ ...record, isLocked: true, opacity: 0.1 } as TLRecord);
      }
    }

    if (toRemove.length === 0 && toAdd.length === 0) return;

    inner.mergeRemoteChanges(() => {
      if (toRemove.length) inner.remove(toRemove);
      if (toAdd.length) inner.put(toAdd);
    });

    for (const id of toRemove) ghostIds.current.delete(id);
    for (const record of toAdd) ghostIds.current.add(record.id as TLShapeId);
  }, [store, handle, diff]);
}

function TldrawInner(props: {
  docUrl: AutomergeUrl;
  element: HTMLElement;
  readOnly: boolean;
}) {
  const key = useMemo(() => `${props.docUrl}-camera`, [props.docUrl]);

  const editor = useEditor();
  const repo = useRepo();
  const handle = useDocHandle<TLDrawDoc>(props.docUrl, { suspense: true });

  usePatchworkDrop(props.element);
  useClearHistoryOnScopeSwap(handle);

  const onChange = useCallback(() => {
    if (!editor) return;
    const camstate = editor.getCameraState();
    if (camstate == "moving") {
      // todo debounce?
      localStorage.setItem(key, JSON.stringify(editor.getCamera()));
    }
  }, []);

  useEffect(() => {
    if (!editor) return;

    // History-pinned views block all canvas editing (the store write-back is
    // also disabled in useAutomergeStore).
    editor.updateInstanceState({ isReadonly: props.readOnly });

    // Give the NewDocTool the repo it needs to create embedded documents.
    setNewDocToolContext(repo, editor);

    // Handle pasted/dropped files (images, videos) by storing them as
    // UnixFileEntry automerge docs and referencing them via service-worker URLs.
    editor.registerExternalAssetHandler("file", async ({ file, assetId }) => {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");

      const id = assetId ?? (`asset:${crypto.randomUUID()}` as TLAssetId);

      const bytes = new Uint8Array(await file.arrayBuffer());

      const ext = extensionForMimeType(file.type);
      const name =
        file.name && file.name !== "image.png"
          ? file.name
          : `Pasted image on ${new Date().toLocaleDateString()}.${ext}`;

      // `create2`, not `create`: only `create2` runs the repo's `idFactory`,
      // which is how keyhive learns about the doc. Without it the file never
      // reaches the sync server and peers see a broken image.
      const fileHandle = await repo.create2<UnixFileEntry>({
        content: bytes,
        extension: ext,
        mimeType: file.type,
        name,
      } as UnixFileEntry);

      // Build the asset using tldraw's helper to get dimensions etc.
      const asset = await getMediaAssetInfoPartial(file, id, isImage, isVideo);

      // Point the asset's src at the service-worker URL for this doc
      asset.props.src = automergeUrlToServiceWorkerUrl(fileHandle.url);

      return asset as TLAsset;
    });

    // Override the tldraw paste handler to avoid "could not migrate content"
    // errors when pasting from newer tldraw versions (e.g. tldraw.com may
    // run a canary build whose schema sequence versions are ahead of ours).
    editor.registerExternalContentHandler(
      "tldraw",
      ({ point, content }: { point?: VecLike; content: TLContent }) => {
        editor.run(() => {
          const selectionBoundsBefore = editor.getSelectionPageBounds();
          editor.markHistoryStoppingPoint("paste");

          for (const shape of content.shapes) {
            if (content.rootShapeIds.includes(shape.id)) {
              shape.isLocked = false;
            }
          }

          // Replace the pasted content's schema with ours so that
          // migrateStoreSnapshot sees matching versions and skips migration
          // rather than failing on unknown future sequence versions.
          content.schema = editor.store.schema.serialize();

          editor.putContentOntoCurrentPage(content, {
            point,
            select: true,
          });

          const selectedBoundsAfter = editor.getSelectionPageBounds();
          if (
            selectionBoundsBefore &&
            selectedBoundsAfter &&
            selectionBoundsBefore.collides(selectedBoundsAfter)
          ) {
            editor.updateInstanceState({ isChangingStyle: true });
          }
        });
      }
    );

    const existing = localStorage.getItem(key);
    if (existing) {
      try {
        const cam = JSON.parse(existing);
        editor.setCamera(cam);
      } catch {
        localStorage.removeItem(key);
      }
    }
    editor.on("change", onChange);
    return () => void editor.off("change", onChange);
  }, [editor, props.readOnly]);
  return null;
}

// Accept documents dragged in from the folder-tree-view / sideboard and other
// Patchwork tools, embedding each as a `patchwork-doc` shape at the drop point.
function usePatchworkDrop(element: HTMLElement) {
  const editor = useEditor();
  const repo = useRepo();

  useEffect(() => {
    if (!editor || !element) return;

    // If the drop lands inside an already-embedded <patchwork-view>, let that
    // inner tool handle it instead of creating a nested embed. The outer
    // <patchwork-view> hosting this canvas appears at/after `element` in the
    // path, so we stop the walk once we reach `element`.
    const isInsideEmbeddedPatchworkView = (e: DragEvent) => {
      for (const el of e.composedPath()) {
        if (el === element) break;
        if ((el as Element).tagName?.toLowerCase() === "patchwork-view")
          return true;
      }
      return false;
    };

    const allowDrop = (e: DragEvent) => {
      if (e.dataTransfer && isPatchworkDrag(e.dataTransfer.types)) {
        e.preventDefault();
        // Dropping embeds a *reference* to the same automerge doc, not a copy.
        e.dataTransfer.dropEffect = "link";
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !isPatchworkDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      if (isInsideEmbeddedPatchworkView(e)) return;
      e.stopImmediatePropagation();

      const docs = parseDroppedDocs(e.dataTransfer);
      if (docs.length === 0) return;

      const dropPoint = editor.screenToPage({ x: e.clientX, y: e.clientY });
      const STAGGER = 24;
      const createdIds: TLShapeId[] = [];

      docs.forEach((item, i) => {
        // Random id (not derived from the doc url) so the same document can be
        // embedded on the canvas any number of times.
        const shapeId = createShapeId();
        createdIds.push(shapeId);

        const knownType = item.type ?? "";
        editor.createShape({
          id: shapeId,
          type: PATCHWORK_DOC_SHAPE_TYPE,
          x: dropPoint.x + i * STAGGER,
          y: dropPoint.y + i * STAGGER,
          rotation: 0,
          parentId: editor.getCurrentPageId(),
          props: {
            w: 640,
            h: 480,
            docUrl: item.url,
            docName: item.name ?? "Loading\u2026",
            docType: knownType,
            toolId: getDefaultToolId(knownType),
          },
        });

        // Resolve datatype/name from the doc when the drag payload didn't
        // include them (e.g. bare-URL drags).
        if (!item.type || !item.name) {
          void (async () => {
            try {
              const handle = await repo.find<{
                "@patchwork"?: { type?: string };
              }>(item.url);
              const doc = handle.doc();
              const datatypeId = doc?.["@patchwork"]?.type ?? knownType;
              if (!editor.getShape(shapeId)) return;
              editor.updateShape({
                id: shapeId,
                type: PATCHWORK_DOC_SHAPE_TYPE,
                props: {
                  docName: item.name ?? datatypeId ?? item.url,
                  docType: datatypeId,
                  toolId: getDefaultToolId(datatypeId),
                },
              });
            } catch (err) {
              console.error("[tldraw4] failed to resolve dropped doc", err);
            }
          })();
        }
      });

      editor.setSelectedShapes(createdIds);
    };

    element.addEventListener("dragenter", allowDrop, { capture: true });
    element.addEventListener("dragover", allowDrop, { capture: true });
    element.addEventListener("drop", handleDrop, { capture: true });
    return () => {
      element.removeEventListener("dragenter", allowDrop, { capture: true });
      element.removeEventListener("dragover", allowDrop, { capture: true });
      element.removeEventListener("drop", handleDrop, { capture: true });
    };
  }, [editor, repo, element]);
}

export function render(handle: any, element: any) {
  const root = createRoot(element);
  root.render(
    <RepoContext.Provider value={element.repo}>
      <TldrawTool docUrl={handle.url} element={element} />
    </RepoContext.Provider>
  );
  return () => root.unmount();
}
