import {
  Geometry2d,
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  createShapeId,
  resizeBox,
  useEditor,
  useValue,
  type RecordProps,
  type TLResizeInfo,
  type TLShape,
  type TLShapeId,
} from "@tldraw/tldraw";
import { useEffect, useRef } from "react";
import { getSupportedToolsForType } from "@inkandswitch/patchwork-plugins";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { useDocument } from "@automerge/automerge-repo-react-hooks";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";

// A tldraw shape embedding another Patchwork document via the shared "embed"
// tool (<patchwork-view tool-id="embed">), which draws the chrome and nests
// the content view. The doc reference lives in the shape props, so it syncs
// like any other shape.

export const PATCHWORK_DOC_SHAPE_TYPE = "patchwork-doc" as const;

declare module "@tldraw/tldraw" {
  export interface TLGlobalShapePropsMap {
    [PATCHWORK_DOC_SHAPE_TYPE]: {
      w: number;
      h: number;
      docUrl: string;
      docName: string;
      docType: string;
      toolId: string;
    };
  }
}

export type PatchworkDocShape = TLShape<typeof PATCHWORK_DOC_SHAPE_TYPE>;

// Deterministic shape id derived from the doc url, so remote peers that create
// a shape for the same document converge on a single shape instead of dupes.
export function makeShapeId(docUrl: string): TLShapeId {
  return createShapeId(docUrl.replace(/[^a-zA-Z0-9]/g, "_"));
}

export class PatchworkDocShapeUtil extends ShapeUtil<PatchworkDocShape> {
  static override type = PATCHWORK_DOC_SHAPE_TYPE;

  static override props: RecordProps<PatchworkDocShape> = {
    w: T.number,
    h: T.number,
    docUrl: T.string,
    docName: T.string,
    docType: T.string,
    toolId: T.string,
  };

  getDefaultProps(): PatchworkDocShape["props"] {
    return {
      w: 640,
      h: 480,
      docUrl: "",
      docName: "Untitled",
      docType: "",
      toolId: "",
    };
  }

  getGeometry(shape: PatchworkDocShape): Geometry2d {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override canResize() {
    return true;
  }
  override canEdit() {
    return true;
  }
  override isAspectRatioLocked() {
    return false;
  }
  override hideRotateHandle() {
    return true;
  }

  override onResize(shape: PatchworkDocShape, info: TLResizeInfo<PatchworkDocShape>) {
    return resizeBox(shape, info);
  }

  component(shape: PatchworkDocShape) {
    return <PatchworkDocComponent shape={shape} />;
  }

  indicator(shape: PatchworkDocShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
}

// Best default tool for a datatype: prefer a tool that explicitly lists the
// datatype over a wildcard ("*") tool; fall back to the first available.
export function getDefaultToolId(datatypeId: string): string {
  if (!datatypeId) return "";
  try {
    const tools = getSupportedToolsForType(datatypeId).filter(
      (t) => !(t as { unlisted?: boolean }).unlisted,
    );
    const specific = tools.find((t) => {
      const supported = (t as { supportedDatatypes?: unknown }).supportedDatatypes;
      return Array.isArray(supported) && supported.includes(datatypeId);
    });
    return (specific ?? tools[0])?.id ?? "";
  } catch {
    return "";
  }
}

function useIsImage(docUrl: string): boolean {
  const [doc] = useDocument<{ "@patchwork"?: { type?: string }; mimeType?: string }>(
    docUrl ? (docUrl as AutomergeUrl) : undefined,
  );
  return doc?.["@patchwork"]?.type === "file" && !!doc?.mimeType?.startsWith("image/");
}

function PatchworkDocComponent({ shape }: { shape: PatchworkDocShape }) {
  const { docUrl, docName, toolId } = shape.props;
  const editor = useEditor();
  const isImage = useIsImage(docUrl);

  const isEditingShape = useValue(
    "is editing shape",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id],
  );
  const isFocused = isEditingShape;

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // While the embedded content is focused, stop tldraw from swallowing
  // keyboard / wheel / pointer events so the inner tool stays interactive.
  useEffect(() => {
    if (!isFocused) return;
    const el = contentRef.current;
    if (!el) return;

    const stopKey = (e: KeyboardEvent) => e.stopPropagation();
    const stopWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) e.stopPropagation();
    };
    const stopPointer = (e: PointerEvent) => e.stopPropagation();

    el.addEventListener("keydown", stopKey);
    el.addEventListener("keyup", stopKey);
    el.addEventListener("keypress", stopKey);
    el.addEventListener("wheel", stopWheel);
    el.addEventListener("pointerdown", stopPointer, true);
    el.addEventListener("pointermove", stopPointer, true);
    el.addEventListener("pointerup", stopPointer, true);
    return () => {
      el.removeEventListener("keydown", stopKey);
      el.removeEventListener("keyup", stopKey);
      el.removeEventListener("keypress", stopKey);
      el.removeEventListener("wheel", stopWheel);
      el.removeEventListener("pointerdown", stopPointer, true);
      el.removeEventListener("pointermove", stopPointer, true);
      el.removeEventListener("pointerup", stopPointer, true);
    };
  }, [isFocused]);

  // Persist tool picks from the embed frame into the shape props.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onToolChanged = (e: Event) => {
      // Stop propagation so nested embeds don't also change the outer embed.
      e.stopPropagation();
      const newToolId = (e as CustomEvent<{ toolId?: string }>).detail?.toolId;
      if (!newToolId) return;
      editor.updateShape({
        id: shape.id,
        type: PATCHWORK_DOC_SHAPE_TYPE,
        props: { toolId: newToolId },
      });
    };
    el.addEventListener("patchwork:embed-tool-changed", onToolChanged);
    return () =>
      el.removeEventListener("patchwork:embed-tool-changed", onToolChanged);
  }, [editor, shape.id]);

  return (
    <HTMLContainer>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid var(--color-panel-contrast, #e5e7eb)",
          borderRadius: "8px",
          background: "var(--color-panel, #ffffff)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
          pointerEvents: "all",
        }}
      >
        {/* Interactive only while editing (double-click); otherwise pointer
            events fall through so tldraw can select and drag the shape. */}
        <div
          ref={contentRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            position: "relative",
            pointerEvents: isFocused ? "auto" : "none",
            userSelect: isFocused ? "text" : "none",
            cursor: isFocused ? "auto" : undefined,
          }}
        >
          {docUrl && isImage ? (
            <img
              src={automergeUrlToServiceWorkerUrl(docUrl as AutomergeUrl)}
              alt={docName}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : docUrl ? (
            // @ts-expect-error Custom element from @inkandswitch/patchwork-elements
            <patchwork-view
              doc-url={docUrl}
              tool-id="embed"
              {...(toolId ? { "embed-tool-id": toolId } : {})}
              key={toolId || "default"}
              style={{ display: "block", width: "100%", height: "100%" }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--color-text-3, #9ca3af)",
                fontSize: "12px",
              }}
            >
              No document
            </div>
          )}
        </div>
      </div>
    </HTMLContainer>
  );
}
