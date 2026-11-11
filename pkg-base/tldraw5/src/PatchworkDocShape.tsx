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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRegistry,
  getSupportedToolsForType,
  type DatatypeDescription,
  type LoadedDatatype,
  type LoadedTool,
} from "@inkandswitch/patchwork-plugins";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { useDocument, useRepo } from "@automerge/automerge-repo-react-hooks";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";

// A tldraw shape that embeds another Patchwork document, rendered via the
// host-provided `<patchwork-view>` custom element. The document reference and
// its display metadata live in the shape props, so they persist through the
// normal tldraw <-> Automerge sync like any other shape.

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

  getIndicatorPath(shape: PatchworkDocShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
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

function useSupportedTools(docType: string): LoadedTool[] {
  return useMemo(() => {
    if (!docType) return [];
    try {
      return getSupportedToolsForType(docType).filter((t) => !(t as { unlisted?: boolean }).unlisted);
    } catch {
      return [];
    }
  }, [docType]);
}

function useIsImage(docUrl: string): boolean {
  const [doc] = useDocument<{ "@patchwork"?: { type?: string }; mimeType?: string }>(
    docUrl ? (docUrl as AutomergeUrl) : undefined,
  );
  return doc?.["@patchwork"]?.type === "file" && !!doc?.mimeType?.startsWith("image/");
}

// Fire the host event that opens the document full-screen in Patchwork. The
// event contract lives in @inkandswitch/patchwork-elements; we dispatch it
// directly to avoid taking a hard dependency on that (externalized) package.
function openDocumentInHost(el: HTMLElement, url: string, toolId?: string) {
  el.dispatchEvent(
    new CustomEvent("patchwork:open-document", {
      detail: { url, toolId: toolId || undefined },
      composed: true,
      bubbles: true,
    }),
  );
}

function PatchworkDocComponent({ shape }: { shape: PatchworkDocShape }) {
  const { docUrl, docName, docType, toolId } = shape.props;
  const editor = useEditor();
  const repo = useRepo();
  const isImage = useIsImage(docUrl);
  const tools = useSupportedTools(docType);

  const isSelectTool = useValue("is select tool", () => editor.getCurrentToolId() === "select", [
    editor,
  ]);
  const isEditingShape = useValue(
    "is editing shape",
    () => editor.getEditingShapeId() === shape.id,
    [editor, shape.id],
  );
  const isFocused = isEditingShape;

  const [isEditingName, setIsEditingName] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);

  const currentTool = tools.find((t) => t.id === toolId) ?? tools[0];

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  // Close the tool menu on outside pointerdown.
  useEffect(() => {
    if (!toolMenuOpen) return;
    const handler = (e: PointerEvent) => {
      if (toolMenuRef.current && !toolMenuRef.current.contains(e.target as Node)) {
        setToolMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, [toolMenuOpen]);

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

  const handleToolChange = useCallback(
    (newToolId: string) => {
      editor.updateShape({
        id: shape.id,
        type: PATCHWORK_DOC_SHAPE_TYPE,
        props: { toolId: newToolId },
      });
      setToolMenuOpen(false);
    },
    [editor, shape.id],
  );

  const handleOpenDocument = useCallback(() => {
    const el = containerRef.current;
    if (!el || !docUrl) return;
    openDocumentInHost(el, docUrl, toolId || undefined);
  }, [docUrl, toolId]);

  const handleRename = useCallback(
    async (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === docName || !docUrl || !docType) {
        setIsEditingName(false);
        return;
      }

      try {
        const datatype = await loadDatatype(docType);
        if (datatype?.module.setTitle) {
          const childHandle = await repo.find<Record<string, unknown>>(docUrl as AutomergeUrl);
          childHandle.change((d) => {
            datatype.module.setTitle!(d, trimmed);
          });
          const childDoc = childHandle.doc();
          const canonicalName = childDoc ? datatype.module.getTitle(childDoc) : trimmed;
          editor.updateShape({
            id: shape.id,
            type: PATCHWORK_DOC_SHAPE_TYPE,
            props: { docName: canonicalName },
          });
        } else {
          editor.updateShape({
            id: shape.id,
            type: PATCHWORK_DOC_SHAPE_TYPE,
            props: { docName: trimmed },
          });
        }
      } catch (err) {
        console.warn("[tldraw5] rename failed", err);
      }

      setIsEditingName(false);
    },
    [editor, shape.id, docName, docUrl, docType, repo],
  );

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
        {/* Titlebar */}
        <div
          onPointerDown={() => {
            if (isEditingShape) editor.setEditingShape(null);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            height: "30px",
            padding: "0 6px",
            borderBottom: "1px solid var(--color-divider, #e5e7eb)",
            flexShrink: 0,
            cursor: "grab",
            userSelect: "none",
            background: "var(--color-low, #fafafa)",
          }}
        >
          {/* Open button */}
          <button
            type="button"
            title="Open document"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenDocument();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "20px",
              height: "20px",
              border: "none",
              borderRadius: "4px",
              background: "transparent",
              cursor: "pointer",
              color: "var(--color-text, #374151)",
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 3h4v4M13 3 7 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Doc name */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {isEditingName ? (
              <input
                ref={nameInputRef}
                defaultValue={docName}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") handleRename((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setIsEditingName(false);
                }}
                onBlur={(e) => handleRename(e.target.value)}
                style={{
                  width: "100%",
                  fontSize: "13px",
                  fontWeight: 600,
                  fontFamily: "inherit",
                  color: "var(--color-text, #111827)",
                  background: "var(--color-panel, #fff)",
                  border: "1px solid var(--color-selected, #2f80ed)",
                  borderRadius: "4px",
                  padding: "1px 4px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            ) : (
              <span
                onPointerDown={(e) => {
                  // Let a plain click start rename without dragging the shape.
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditingName(true);
                }}
                title={docName}
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--color-text, #111827)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  cursor: "text",
                }}
              >
                {docName || "Untitled"}
              </span>
            )}
          </div>

          {/* Tool picker */}
          {currentTool && (
            <div ref={toolMenuRef} style={{ position: "relative", flexShrink: 0 }}>
              <button
                type="button"
                title="Choose view"
                onClick={(e) => {
                  e.stopPropagation();
                  if (tools.length > 1) setToolMenuOpen((v) => !v);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  maxWidth: "140px",
                  padding: "2px 8px",
                  border: "1px solid var(--color-divider, #e5e7eb)",
                  borderRadius: "9999px",
                  background: "var(--color-panel, #fff)",
                  cursor: tools.length > 1 ? "pointer" : "default",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: "var(--color-text-1, #4b5563)",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {currentTool.name}
                </span>
                {tools.length > 1 && (
                  <svg width="8" height="8" viewBox="0 0 8 8" style={{ opacity: 0.6 }}>
                    <path
                      d="M1 2.5 4 5.5 7 2.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>

              {toolMenuOpen && tools.length > 1 && (
                <div
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: "4px",
                    background: "var(--color-panel, #fff)",
                    border: "1px solid var(--color-divider, #e5e7eb)",
                    borderRadius: "6px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                    padding: "4px",
                    minWidth: "140px",
                    zIndex: 10000,
                  }}
                >
                  {tools.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleToolChange(t.id);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        padding: "5px 10px",
                        border: "none",
                        borderRadius: "4px",
                        background: t.id === currentTool.id ? "var(--color-selected, #e8f0fe)" : "transparent",
                        cursor: "pointer",
                        fontSize: "12px",
                        color: "var(--color-text, #374151)",
                        textAlign: "left",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Content */}
        <div
          ref={contentRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            position: "relative",
            pointerEvents: isSelectTool ? "auto" : "none",
            userSelect: isFocused ? "text" : "none",
            cursor: isFocused ? "auto" : undefined,
          }}
          onPointerDown={
            isSelectTool
              ? (e) => {
                  e.stopPropagation();
                  if (!isEditingShape) editor.setEditingShape(shape.id);
                }
              : undefined
          }
          onPointerUp={
            isSelectTool
              ? (e) => {
                  e.stopPropagation();
                  // Synthesize a click for frameworks that rely on
                  // document-level event delegation (e.g. Solid.js); tldraw's
                  // preventDefault on pointerdown suppresses the native click.
                  (e.target as HTMLElement)?.dispatchEvent(
                    new MouseEvent("click", {
                      bubbles: true,
                      cancelable: true,
                      view: window,
                      clientX: e.clientX,
                      clientY: e.clientY,
                    }),
                  );
                }
              : undefined
          }
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
              {...(toolId ? { "tool-id": toolId } : {})}
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

async function loadDatatype(id: string): Promise<LoadedDatatype | undefined> {
  try {
    const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
    return (await registry.load(id)) as unknown as LoadedDatatype | undefined;
  } catch {
    return undefined;
  }
}
