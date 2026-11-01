// A tldraw tool for the undo e2e test, bundled by the spec with esbuild
// (tldraw isn't in the import map; Automerge and the undo service are).
//
// `mount(element, handle, { bound })` renders tldraw. Unbound, it uses
// tldraw's own history. Bound, its store is mirrored into `handle`'s
// document (as a binding does: the user's document-scope changes written
// property by property, the document's other changes put back into the
// store) and its undo goes to the service.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Tldraw } from "tldraw";
import css from "tldraw/tldraw.css";
import * as A from "@automerge/automerge/slim";
import { undoFor } from "@inkandswitch/patchwork-undo";
import {
  bindTldraw,
  tldrawOptions,
  tldrawOverrides,
} from "@inkandswitch/patchwork-undo/tldraw";

const json = (value) => JSON.parse(JSON.stringify(value ?? null));

function mirror(editor, handle) {
  let writing = false;
  const documentTypes = editor.store.scopedTypes.document;
  handle.change((doc) => {
    doc.store ??= {};
    for (const record of editor.store.allRecords()) {
      if (documentTypes.has(record.typeName))
        doc.store[record.id] = json(record);
    }
  });
  const stopListening = editor.store.listen(
    ({ changes }) => {
      writing = true;
      handle.change((doc) => {
        for (const record of Object.values(changes.added)) {
          doc.store[record.id] = json(record);
        }
        for (const [, to] of Object.values(changes.updated)) {
          const target = doc.store[to.id];
          for (const [key, value] of Object.entries(to)) {
            const next = json(value);
            if (JSON.stringify(target[key]) === JSON.stringify(next)) continue;
            if (key === "props" && next && typeof next === "object") {
              for (const [k, v] of Object.entries(next)) {
                if (JSON.stringify(target.props[k]) !== JSON.stringify(v)) {
                  target.props[k] = v;
                }
              }
            } else {
              target[key] = next;
            }
          }
        }
        for (const record of Object.values(changes.removed)) {
          delete doc.store[record.id];
        }
      });
      writing = false;
    },
    { source: "user", scope: "document" }
  );
  const onChange = () => {
    if (writing) return;
    const store = handle.doc().store;
    editor.store.mergeRemoteChanges(() => {
      const current = new Map(
        editor.store
          .allRecords()
          .filter((r) => documentTypes.has(r.typeName))
          .map((r) => [r.id, r])
      );
      const put = [];
      for (const [id, record] of Object.entries(store)) {
        const next = json(record);
        if (JSON.stringify(current.get(id)) !== JSON.stringify(next))
          put.push(next);
        current.delete(id);
      }
      editor.store.put(put);
      editor.store.remove([...current.keys()]);
    });
  };
  handle.on("change", onChange);
  return () => {
    stopListening();
    handle.off("change", onChange);
  };
}

export function mount(element, handle, { bound }) {
  if (!document.getElementById("tldraw-css")) {
    const style = document.createElement("style");
    style.id = "tldraw-css";
    style.textContent = css;
    document.head.append(style);
  }
  return new Promise((resolve) => {
    const undo = bound ? undoFor(element, handle, tldrawOptions()) : undefined;
    element.undo = undo;
    const onMount = (editor) => {
      if (undo) {
        mirror(editor, handle);
        // The seeding above is not the user's.
        undo.history.reset();
        bindTldraw(editor, undo);
      }
      resolve(editor);
    };
    createRoot(element).render(
      createElement(Tldraw, {
        onMount,
        overrides: undo ? tldrawOverrides(undo) : undefined,
      })
    );
  });
}
