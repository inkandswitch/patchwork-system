// `ctx.helpers` — the editor-bound convenience bag a document script receives,
// mirroring the desktop app's `ScriptHelpers`. Pure tldraw primitives are not
// in here; scripts import those from 'tldraw' directly.

import {
  Box,
  createShapeId,
  renderPlaintextFromRichText,
  type Editor,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
} from "@tldraw/tldraw";

type ShapeRef = string | { id?: string; shapeId?: string };

function refToId(ref: ShapeRef): TLShapeId {
  if (typeof ref === "string") return ref as TLShapeId;
  return (ref.id ?? ref.shapeId) as TLShapeId;
}

export function makeScriptHelpers(editor: Editor) {
  const createShapeIfMissing = (shape: TLShapePartial & { id: TLShapeId }) => {
    if (editor.getShape(shape.id)) return false;
    editor.createShape(shape);
    return true;
  };

  return {
    richTextToPlainText(value: unknown): string {
      if (typeof value === "string") return value;
      if (!value) return "";
      try {
        return renderPlaintextFromRichText(editor, value as never);
      } catch {
        return "";
      }
    },

    createShapeIfMissing,

    createShapesIfMissing(shapes: Array<TLShapePartial & { id: TLShapeId }>) {
      const created: TLShapeId[] = [];
      for (const shape of shapes) {
        if (createShapeIfMissing(shape)) created.push(shape.id);
      }
      return created;
    },

    translateShapes(refs: ShapeRef[], dx: number, dy: number) {
      const moved: TLShapeId[] = [];
      const partials: TLShapePartial[] = [];
      for (const ref of refs) {
        const id = refToId(ref);
        const shape = editor.getShape(id);
        if (!shape) continue;
        partials.push({
          id,
          type: shape.type,
          x: shape.x + dx,
          y: shape.y + dy,
        } as TLShapePartial);
        moved.push(id);
      }
      if (partials.length) {
        editor.run(() => editor.updateShapes(partials), { history: "ignore" });
      }
      return moved;
    },

    // Fires only when the anchor alone moved: a resize or rotation also shifts
    // x/y, and a multi-shape drag would move script-owned internals twice.
    onShapeTranslate(
      shapeRef: string | TLShapeId,
      handler: (info: {
        dx: number;
        dy: number;
        prev: TLShape;
        next: TLShape;
      }) => void,
      options?: { signal?: AbortSignal }
    ) {
      const id = shapeRef as TLShapeId;
      const unlisten = editor.store.listen(
        ({ changes }) => {
          const updated = Object.values(changes.updated);
          if (updated.length !== 1) return;
          const [prev, next] = updated[0] as [TLShape, TLShape];
          if (prev.id !== id || next.typeName !== "shape") return;
          const dx = next.x - prev.x;
          const dy = next.y - prev.y;
          if (dx === 0 && dy === 0) return;
          if (
            prev.rotation !== next.rotation ||
            JSON.stringify(prev.props) !== JSON.stringify(next.props)
          ) {
            return;
          }
          handler({ dx, dy, prev, next });
        },
        { source: "user", scope: "document" }
      );
      options?.signal?.addEventListener("abort", unlisten, { once: true });
      return unlisten;
    },

    createArrowBetweenShapes(
      fromShapeId: string,
      toShapeId: string,
      options: {
        bend?: number;
        arrowheadStart?: string;
        arrowheadEnd?: string;
        richText?: unknown;
      } = {}
    ) {
      const id = createShapeId();
      editor.createShape({
        id,
        type: "arrow",
        props: {
          bend: options.bend ?? 0,
          arrowheadStart: options.arrowheadStart ?? "none",
          arrowheadEnd: options.arrowheadEnd ?? "arrow",
          ...(options.richText ? { richText: options.richText } : {}),
        },
      } as TLShapePartial);
      editor.createBindings([
        {
          type: "arrow",
          fromId: id,
          toId: fromShapeId as TLShapeId,
          props: { terminal: "start" },
        },
        {
          type: "arrow",
          fromId: id,
          toId: toShapeId as TLShapeId,
          props: { terminal: "end" },
        },
      ] as never);
      return id;
    },

    boxShapes(
      refs: ShapeRef[],
      options: {
        shapeId?: string;
        color?: string;
        fill?: string;
        text?: string;
      } = {}
    ) {
      const boxes = refs
        .map((ref) => editor.getShapePageBounds(refToId(ref)))
        .filter(Boolean) as Box[];
      if (!boxes.length) return editor;

      const bounds = Box.Common(boxes);
      const padding = 16;
      editor.createShape({
        id: (options.shapeId as TLShapeId) ?? createShapeId(),
        type: "geo",
        x: bounds.x - padding,
        y: bounds.y - padding,
        props: {
          geo: "rectangle",
          w: bounds.w + padding * 2,
          h: bounds.h + padding * 2,
          color: options.color ?? "black",
          fill: options.fill ?? "none",
        },
      } as TLShapePartial);
      return editor;
    },

    // The desktop app's lints are heuristics over its own layout rules; rather
    // than invent different ones, this reports nothing.
    getLints() {
      return { lints: [] as Array<{ type: string; shapeIds: string[]; message: string }> };
    },

    // Patchwork persists through Automerge continuously — there is no file to
    // save, and the desktop contract forbids scripts calling this anyway.
    async saveDoc() {
      throw new Error("saveDoc() is not available outside the tldraw desktop app");
    },
  };
}

export type ScriptHelpers = ReturnType<typeof makeScriptHelpers>;
