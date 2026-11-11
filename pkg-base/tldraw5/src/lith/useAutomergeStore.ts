import {
  type TLAnyShapeUtilConstructor,
  type TLRecord,
  type TLStoreWithStatus,
  createTLStore,
  type TLAnyBindingUtilConstructor,
  type HistoryEntry,
  defaultUserPreferences,
  createUserId,
  type TLUser,
  createPresenceStateDerivation,
  InstancePresenceRecordType,
  computed,
  react,
  type TLStoreSnapshot,
  type TLInstancePresence,
  sortById,
  useEditor,
} from "@tldraw/tldraw";
import { useEffect, useRef, useState } from "react";
import {
  type DocHandle,
  type DocHandleChangePayload,
} from "@automerge/automerge-repo/slim";
import { usePresence } from "@automerge/automerge-repo-react-hooks";

import { applyAutomergePatchesToTLStore } from "./AutomergeToTLStore.js";
import { applyTLStoreChangesToAutomerge } from "./TLStoreToAutomerge.js";

// `shapeUtils` / `bindingUtils` are the complete lists — a document script's
// `config.js` may have added to or replaced the defaults, and the store has to
// agree with the editor about them or records of a custom type fail validation.
export function useAutomergeStore({
  handle,
  shapeUtils = [],
  bindingUtils = [],
  readOnly = false,
}: {
  handle: DocHandle<TLStoreSnapshot>;
  userId: string;
  shapeUtils?: TLAnyShapeUtilConstructor[];
  bindingUtils?: TLAnyBindingUtilConstructor[];
  readOnly?: boolean;
}): TLStoreWithStatus {
  const [store] = useState(() => {
    const store = createTLStore({ shapeUtils, bindingUtils });
    return store;
  });

  const [storeWithStatus, setStoreWithStatus] = useState<TLStoreWithStatus>({
    status: "loading",
  });

  // Read through a ref inside the write-back listener so a mid-session flip
  // (see `useIsHandleReadOnly`) doesn't re-run the store effect below — that
  // would re-load the snapshot and clear session records (camera, selection).
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  /* -------------------- TLDraw <--> Automerge -------------------- */
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // A hacky workaround to prevent local changes from being applied twice
    // once into the automerge doc and then back again.
    let preventPatchApplications = false;

    /* TLDraw to Automerge */
    function syncStoreChangesToAutomergeDoc({
      changes,
    }: HistoryEntry<TLRecord>) {
      // A read-only (history-pinned) handle is at fixed heads and rejects
      // `handle.change`, so never forward store edits back to Automerge.
      if (readOnlyRef.current) return;
      preventPatchApplications = true;
      handle.change((doc) => {
        applyTLStoreChangesToAutomerge(doc, changes);
      });
      preventPatchApplications = false;
    }

    unsubs.push(
      store.listen(syncStoreChangesToAutomergeDoc, {
        source: "user",
        scope: "document",
      })
    );

    /* Automerge to TLDraw */
    const syncAutomergeDocChangesToStore = ({
      patches,
      scopeReplaced,
      doc,
    }: DocHandleChangePayload<TLStoreSnapshot>) => {
      if (preventPatchApplications) return;

      // A wholesale scope replacement (e.g. the draft overlay re-pointing
      // this handle at a different clone) carries no patch stream connecting
      // the old doc to the new one. Diff the new doc's *document*-scope
      // records into the store rather than `loadStoreSnapshot`: that would
      // `clear()` the session-scope records too (camera/zoom, current page,
      // selection), which should survive a draft switch. Drafts are forks of
      // each other, so most records are identical and `put` skips them.
      if (scopeReplaced) {
        const swapped = handle.doc();
        if (!swapped?.store) return;
        const migrated = store.schema.migrateStoreSnapshot({
          store: JSON.parse(JSON.stringify(swapped.store)),
          schema: JSON.parse(JSON.stringify(swapped.schema)),
        });
        if (migrated.type === "error") {
          console.error(
            "[tldraw5] failed to migrate swapped-in snapshot:",
            migrated.reason
          );
          return;
        }
        const next = migrated.value;
        store.mergeRemoteChanges(() => {
          const toRemove = store
            .allRecords()
            .filter(
              (record) =>
                store.scopedTypes.document.has(record.typeName) &&
                !(record.id in next)
            )
            .map((record) => record.id);
          if (toRemove.length) store.remove(toRemove);
          store.put(Object.values(next));
        });
        return;
      }

      applyAutomergePatchesToTLStore(patches, store, doc ?? handle.doc());
    };

    handle.on("change", syncAutomergeDocChangesToStore);
    unsubs.push(() => handle.off("change", syncAutomergeDocChangesToStore));

    /* Load the initial document snapshot into the store. */
    // TODO: need to think through the various status possibilities here and how they map
    const doc = handle.doc();
    if (!doc) throw new Error("Document not found");
    if (!doc.store) throw new Error("Document store not initialized");

    store.mergeRemoteChanges(() => {
      store.loadStoreSnapshot({
        store: structuredClone(doc.store),
        schema: structuredClone(doc.schema),
      });
    });

    setStoreWithStatus({
      store,
      status: "synced-remote",
      connectionStatus: "online",
    });

    return () => {
      unsubs.forEach((fn) => fn());
      unsubs.length = 0;
    };
  }, [handle, store]);

  return storeWithStatus;
}

// A handle's read-only state (`isReadOnly()`, true at fixed heads) can flip in
// place: its backing may be swapped without the handle identity changing (a
// `change` event with `scopeReplaced: true`). Track it as state re-read on
// every swap rather than sampling it once per mount.
export function useIsHandleReadOnly(
  handle: DocHandle<TLStoreSnapshot>
): boolean {
  const [readOnly, setReadOnly] = useState(() => handle.isReadOnly());

  useEffect(() => {
    setReadOnly(handle.isReadOnly());
    const onChange = (payload: DocHandleChangePayload<TLStoreSnapshot>) => {
      if (payload.scopeReplaced) setReadOnly(handle.isReadOnly());
    };
    handle.on("change", onChange);
    return () => void handle.off("change", onChange);
  }, [handle]);

  return readOnly;
}

// A scope swap (a `change` event with `scopeReplaced: true` -- the draft
// overlay re-pointing this handle at a different clone when scrubbing history
// or switching drafts) invalidates the undo stack: its entries describe a
// different timeline. The swapped-in records themselves are applied via
// `mergeRemoteChanges` in `useAutomergeStore` above (so they are never
// recorded); clearing the stale stack is all that's left to do.
//
// This can't live in `useAutomergeStore` directly: undo history is not a
// store concern -- the `HistoryManager` belongs to the `Editor`, which tldraw
// only creates internally once `<Tldraw store={...}>` mounts. The store hook
// runs outside `<Tldraw>`, before any editor exists, so the history-clearing
// half of the swap handling has to be a separate hook rendered *inside*
// `<Tldraw>`, where `useEditor()` can reach the editor.
export function useClearHistoryOnScopeSwap(handle: DocHandle<TLStoreSnapshot>) {
  const editor = useEditor();

  useEffect(() => {
    if (!editor) return;
    const onChange = (payload: DocHandleChangePayload<TLStoreSnapshot>) => {
      if (payload.scopeReplaced) editor.clearHistory();
    };
    handle.on("change", onChange);
    return () => void handle.off("change", onChange);
  }, [editor, handle]);
}

// Ephemeral state shared with peers: our tldraw presence record, or null if window is not focused
type PresenceChannels = { presence: TLInstancePresence | null };

export function useAutomergePresence({
  handle,
  store,
  userMetadata,
  element,
}: {
  handle: DocHandle<TLStoreSnapshot>;
  store: TLStoreWithStatus;
  userMetadata: any;
  element: HTMLElement;
}) {
  const innerStore = store?.store;

  const { userId, name, color } = userMetadata;

  const isCursorActive = useIsCursorActive(element);

  const { peerStates, update, stop } = usePresence<PresenceChannels>({
    handle,
    initialState: { presence: null },
  });

  useEffect(() => {
    if (!innerStore) return;

    // Records are keyed by peerId so multiple sessions of the same user stay distinct.
    const toPut: TLRecord[] = peerStates.peers
      .filter((peer) => peer.value?.presence)
      .map((peer) => ({
        ...peer.value.presence!,
        id: InstancePresenceRecordType.createId(peer.peerId),
      }));

    const toRemove = innerStore.query
      .records("instance_presence")
      .get()
      .sort(sortById)
      .map((record) => record.id)
      .filter((id) => !toPut.find((record) => record.id === id));

    if (toRemove.length) innerStore.remove(toRemove);
    if (toPut.length) innerStore.put(toPut);
  }, [innerStore, peerStates]);

  useEffect(() => {
    if (!innerStore) return;
    // tldraw 5 derives presence from a `TLUser` signal rather than from local
    // user preferences, so the identity we get from the Patchwork contact goes
    // straight in instead of round-tripping through `setUserPreferences`.
    const user = computed<TLUser>("user", () => ({
      typeName: "user",
      id: createUserId(userId),
      name,
      color: color ?? defaultUserPreferences.color,
      imageUrl: "",
      meta: {},
    }));

    const presenceDerivation = createPresenceStateDerivation(user)(innerStore);

    // Closing the page sends a goodbye, which removes our record from peers.
    window.addEventListener("pagehide", stop);

    let cancelled = false;
    let dispose: (() => void) | undefined;

    if (isCursorActive) {
      dispose = react("broadcast presence", () => {
        const presence = presenceDerivation.get();
        // rAF throttles broadcasts to frame rate.
        requestAnimationFrame(() => {
          if (cancelled) return;
          // Stamp activity so becoming active again shows the cursor without
          // waiting for a pointer move to refresh the store's stale timestamp.
          update(
            "presence",
            presence ? { ...presence, lastActivityTimestamp: Date.now() } : null
          );
        });
      });
    } else {
      // Keep the record but clear the cursor when blurred or pointer leaves
      const presence = presenceDerivation.get();
      update("presence", presence ? { ...presence, cursor: null } : null);
    }

    return () => {
      // Invalidate pending rAF broadcasts so stale updates don't overwrite deactivated cursors.
      cancelled = true;
      dispose?.();
      window.removeEventListener("pagehide", stop);
    };
  }, [innerStore, userId, name, color, update, stop, isCursorActive]);
}

// The local cursor is active only when the window is focused and the pointer is over this tool.
function useIsCursorActive(element: HTMLElement) {
  const [isFocused, setIsFocused] = useState(() => document.hasFocus());
  const [isPointerOver, setIsPointerOver] = useState(() =>
    element.matches(":hover")
  );

  useEffect(() => {
    const onFocus = () => setIsFocused(true);
    const onBlur = () => setIsFocused(false);
    const onEnter = () => setIsPointerOver(true);
    const onLeave = () => setIsPointerOver(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    element.addEventListener("mouseenter", onEnter);
    element.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      element.removeEventListener("mouseenter", onEnter);
      element.removeEventListener("mouseleave", onLeave);
    };
  }, [element]);

  return isFocused && isPointerOver;
}
