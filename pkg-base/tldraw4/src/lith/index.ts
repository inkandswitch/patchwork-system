import type { TLStoreSnapshot } from "@tldraw/tldraw";
import { createTLStore, defaultShapeUtils } from "@tldraw/tldraw";

/* a similar pattern to other automerge init functions */
export function init(doc: TLStoreSnapshot) {
  const store = createTLStore({
    shapeUtils: defaultShapeUtils,
  });
  const snapshot = store.getStoreSnapshot();
  Object.assign(doc, snapshot);
}

export * from "./useAutomergeStore";
