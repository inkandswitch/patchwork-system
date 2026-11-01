// @vitest-environment happy-dom
import {
  BaseBoxShapeUtil,
  Editor,
  T,
  createShapeId,
  createTLStore,
  type TLRecord,
} from "@tldraw/editor";
import { afterEach, describe, expect, test } from "vitest";

import { UndoHistory } from "../src/history.js";
import {
  bindTldraw,
  tldrawIgnore,
  tldrawOptions,
  tldrawOverrides,
} from "../src/tldraw.js";
import { peers, type Peer } from "./peers.js";

// A minimal box shape: the comparison is about history, not rendering.
class BoxUtil extends BaseBoxShapeUtil<any> {
  static override type = "box" as const;
  static override props = { w: T.number, h: T.number };
  override getDefaultProps() {
    return { w: 1, h: 1 };
  }
  override component() {
    return null;
  }
  override indicator() {
    return null;
  }
}

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function makeEditor() {
  const shapeUtils = [BoxUtil];
  const container = document.createElement("div");
  document.body.append(container);
  const editor = new Editor({
    store: createTLStore({ shapeUtils, bindingUtils: [] }),
    shapeUtils,
    bindingUtils: [],
    tools: [],
    getContainer: () => container,
  });
  editors.push(editor);
  return editor;
}

type Doc = { store: Record<string, unknown> };

/**
 * Mirror a tldraw store into an Automerge document the way a binding does:
 * the user's document-scope changes are written property by property, and
 * whatever changes the document (here: an undo) is put back into the store.
 */
function mirror(editor: Editor, peer: Peer<Doc>) {
  let writing = false;
  editor.store.listen(
    ({ changes }) => {
      writing = true;
      peer.handle.change((d) => {
        for (const record of Object.values(changes.added)) {
          d.store[record.id] = JSON.parse(JSON.stringify(record));
        }
        for (const [, to] of Object.values(changes.updated)) {
          const target = d.store[to.id] as Record<string, unknown>;
          for (const [key, value] of Object.entries(to)) {
            const json = JSON.parse(JSON.stringify(value ?? null));
            if (JSON.stringify(target[key]) === JSON.stringify(json)) continue;
            if (key === "props" && typeof json === "object") {
              const props = target.props as Record<string, unknown>;
              for (const [k, v] of Object.entries(json)) {
                if (JSON.stringify(props[k]) !== JSON.stringify(v))
                  props[k] = v;
              }
            } else target[key] = json;
          }
        }
        for (const record of Object.values(changes.removed)) {
          delete d.store[record.id];
        }
      });
      writing = false;
    },
    { source: "user", scope: "document" }
  );
  peer.handle.on("change", () => {
    if (writing) return;
    const doc = peer.doc();
    editor.store.mergeRemoteChanges(() => {
      const current = new Map(
        editor.store.allRecords().map((r) => [r.id as string, r])
      );
      const put: TLRecord[] = [];
      for (const [id, record] of Object.entries(doc.store)) {
        const json = JSON.parse(JSON.stringify(record)) as TLRecord;
        if (JSON.stringify(current.get(id)) !== JSON.stringify(json))
          put.push(json);
        current.delete(id);
      }
      editor.store.put(put);
      const gone = [...current.values()].filter((r) =>
        editor.store.scopedTypes.document.has(r.typeName)
      );
      editor.store.remove(gone.map((r) => r.id));
    });
  });
}

const shapes = (editor: Editor) =>
  editor
    .getCurrentPageShapes()
    .map((s) => ({ id: s.id, x: s.x, y: s.y, props: s.props }))
    .sort((a, b) => a.id.localeCompare(b.id));

/** The same interactions on both editors, as tldraw's tools perform them. */
function script(editor: Editor, advance: (ms: number) => void) {
  const a = createShapeId("a");
  const b = createShapeId("b");
  // draw: a mark, a create, then the drag
  editor.markHistoryStoppingPoint("creating");
  editor.createShape({
    id: a,
    type: "box",
    x: 0,
    y: 0,
    props: { w: 1, h: 1 },
  } as any);
  for (let i = 2; i <= 6; i++) {
    editor.updateShape({
      id: a,
      type: "box",
      props: { w: i * 10, h: i * 5 },
    } as any);
    advance(50);
  }
  // draw with a pause mid-drag
  editor.markHistoryStoppingPoint("creating");
  editor.createShape({
    id: b,
    type: "box",
    x: 100,
    y: 0,
    props: { w: 1, h: 1 },
  } as any);
  for (let i = 2; i <= 6; i++) {
    editor.updateShape({
      id: b,
      type: "box",
      props: { w: i * 7, h: i * 3 },
    } as any);
    advance(i === 3 ? 2_000 : 50);
  }
  // move
  editor.markHistoryStoppingPoint("translating");
  for (let i = 1; i <= 5; i++) {
    editor.updateShape({ id: a, type: "box", x: i * 3, y: i * 2 } as any);
    advance(50);
  }
  // delete
  editor.markHistoryStoppingPoint("deleting");
  editor.deleteShapes([b]);
}

describe("tldraw", () => {
  test("its own history and the service give the same shapes", () => {
    const own = makeEditor();
    const bound = makeEditor();
    const peer = peers<Doc>({ store: {} }).alice;
    peer.history.dispose();
    let now = 0;
    const history = new UndoHistory(peer.handle as never, {
      now: () => now,
      ...tldrawOptions(),
    });
    mirror(bound, peer);
    // Seed the document with the editor's initial records, outside history.
    peer.handle.change((d) => {
      for (const record of bound.store.allRecords()) {
        if (!bound.store.scopedTypes.document.has(record.typeName)) continue;
        d.store[record.id] = JSON.parse(JSON.stringify(record));
      }
    });
    history.reset();
    bindTldraw(bound, {
      undo: () => history.undo(),
      redo: () => history.redo(),
      checkpoint: () => history.checkpoint(),
      get canUndo() {
        return history.canUndo;
      },
      get canRedo() {
        return history.canRedo;
      },
    });
    own.clearHistory();

    script(own, () => {});
    script(bound, (ms) => (now += ms));
    expect(shapes(bound)).toEqual(shapes(own));
    expect(history.size).toBe(4);

    let presses = 0;
    while (own.canUndo()) {
      own.undo();
      bound.undo();
      expect(shapes(bound), `after undo ${++presses}`).toEqual(shapes(own));
    }
    expect(bound.canUndo()).toBe(false);
    while (own.canRedo()) {
      own.redo();
      bound.redo();
      expect(shapes(bound), `after redo ${++presses}`).toEqual(shapes(own));
    }
    expect(bound.canRedo()).toBe(false);
  });

  test("bindTldraw's teardown restores the editor", () => {
    const editor = makeEditor();
    const { undo, redo } = editor;
    const mark = editor.history._mark;
    const off = bindTldraw(editor, {
      undo: () => ({}) as never,
      redo: () => ({}) as never,
      checkpoint: () => {},
      canUndo: false,
      canRedo: false,
    });
    expect(editor.undo).not.toBe(undo);
    off();
    expect(editor.undo).toBe(undo);
    expect(editor.redo).toBe(redo);
    expect(editor.history._mark).toBe(mark);
  });
});

describe("tldraw UI", () => {
  test("tldrawOverrides routes the undo and redo actions", () => {
    const calls: string[] = [];
    const overrides = tldrawOverrides({
      undo: () => (calls.push("undo"), {}) as never,
      redo: () => (calls.push("redo"), {}) as never,
    });
    const actions = overrides.actions(undefined, {
      undo: { id: "undo", kbd: "$z", onSelect: () => calls.push("own undo") },
      redo: { id: "redo", kbd: "$!z", onSelect: () => calls.push("own redo") },
      copy: { id: "copy", onSelect: () => calls.push("copy") },
    });
    actions.undo!.onSelect("menu");
    actions.redo!.onSelect("kbd");
    actions.copy!.onSelect("menu");
    expect(calls).toEqual(["undo", "redo", "copy"]);
    expect(actions.undo!.kbd).toBe("$z");
  });

  test("tldrawIgnore leaves out the user record only", () => {
    const ignore = tldrawIgnore();
    expect(ignore(["store", "user:abc", "name"])).toBe(true);
    expect(ignore(["store", "shape:abc"])).toBe(false);
    expect(ignore(["other", "user:abc"])).toBe(false);
    expect(tldrawOptions().groupDelayMs).toBe(Infinity);
  });
});
