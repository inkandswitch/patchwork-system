import type { TLRecord, TLStore } from "@tldraw/tldraw";
import * as Automerge from "@automerge/automerge/slim";

/**
 * Sync automerge doc changes into the tldraw store.
 *
 * The patches are only used to find out *which* records changed; the record
 * contents are rebuilt wholesale from the doc. Replaying patch mechanics
 * against store records would require modeling every patch shape automerge
 * can emit (nested `del`, `splice`, `conflict`, ...) and any gap silently
 * diverges the view from the doc until reload. Rebuilding from the doc makes
 * the doc the single source of truth: after every change the store record is
 * exactly what the doc says, regardless of what the patches looked like.
 * tldraw records are small, so the per-record rebuild cost is negligible.
 */
export function applyAutomergePatchesToTLStore(
  patches: Automerge.Patch[],
  store: TLStore,
  doc: { store: Record<string, unknown> }
) {
  const changedIds = new Set<string>();
  for (const patch of patches) {
    if (patch.path[0] === "store" && patch.path.length > 1) {
      changedIds.add(`${patch.path[1]}`);
    }
  }

  const toRemove: TLRecord["id"][] = [];
  const toPut: TLRecord[] = [];
  for (const id of changedIds) {
    const record = doc.store[id];
    if (record === undefined) {
      toRemove.push(id as TLRecord["id"]);
    } else {
      toPut.push(structuredClone(record) as TLRecord);
    }
  }

  store.mergeRemoteChanges(() => {
    if (toRemove.length) store.remove(toRemove);
    if (toPut.length) store.put(toPut);
  });
}
