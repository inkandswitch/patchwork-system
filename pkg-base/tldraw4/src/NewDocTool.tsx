/**
 * NewDocTool — a tldraw tool that lets the user draw a box to create a new
 * embedded Patchwork document of a chosen datatype.
 *
 * Exports:
 *   - NewDocShapeTool        — pass to Tldraw `tools`
 *   - newDocUiOverrides      — spread into Tldraw `overrides`
 *   - NewDocToolbar          — pass as Tldraw `components.Toolbar`
 *   - setNewDocToolContext() — call once per editor when it's ready
 */

import {
  DefaultToolbar,
  DefaultToolbarContent,
  StateNode,
  createShapeId,
  useEditor,
  useValue,
  type Editor,
  type TLPointerEventInfo,
  type TLUiOverrides,
  type TLUiToolsContextType,
} from "@tldraw/tldraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Repo } from "@automerge/automerge-repo/slim";
import {
  createDocOfDatatype2,
  getRegistry,
  type DatatypeDescription,
  type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins";
import { PATCHWORK_DOC_SHAPE_TYPE, makeShapeId } from "./PatchworkDocShape.tsx";

// Per-editor context, keyed by editor instance, so a nested canvas embedded in
// another canvas doesn't clobber the outer one's repo reference.
interface NewDocContext {
  repo: Repo;
}

const _contextByEditor = new WeakMap<Editor, NewDocContext>();
let _selectedDatatypeId = "";

export function setNewDocToolContext(repo: Repo, editor: Editor) {
  _contextByEditor.set(editor, { repo });
}

export function setSelectedDatatypeId(id: string) {
  _selectedDatatypeId = id;
}

function getListedDatatypeDescriptions(): DatatypeDescription[] {
  try {
    const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
    return registry.filter((d) => !(d as DatatypeDescription).unlisted) as unknown as DatatypeDescription[];
  } catch {
    return [];
  }
}

async function loadDatatype(id: string): Promise<LoadedDatatype | undefined> {
  try {
    const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
    return (await registry.load(id)) as unknown as LoadedDatatype | undefined;
  } catch {
    return undefined;
  }
}

export class NewDocShapeTool extends StateNode {
  static override id = "new-doc";

  private startPoint = { x: 0, y: 0 };
  private previewId: ReturnType<typeof createShapeId> | null = null;

  override onPointerDown(_info: TLPointerEventInfo) {
    const { currentPagePoint } = this.editor.inputs;
    this.startPoint = { x: currentPagePoint.x, y: currentPagePoint.y };

    this.previewId = createShapeId();
    this.editor.createShape({
      id: this.previewId,
      type: "geo",
      x: currentPagePoint.x,
      y: currentPagePoint.y,
      parentId: this.editor.getCurrentPageId(),
      props: { w: 1, h: 1, geo: "rectangle", dash: "dashed", fill: "none" },
    });
  }

  override onPointerMove(_info: TLPointerEventInfo) {
    if (!this.previewId) return;
    const { currentPagePoint } = this.editor.inputs;
    const x = Math.min(this.startPoint.x, currentPagePoint.x);
    const y = Math.min(this.startPoint.y, currentPagePoint.y);
    const w = Math.max(1, Math.abs(currentPagePoint.x - this.startPoint.x));
    const h = Math.max(1, Math.abs(currentPagePoint.y - this.startPoint.y));
    this.editor.updateShape({ id: this.previewId, type: "geo", x, y, props: { w, h } });
  }

  override onCancel() {
    this.cleanup();
    this.editor.setCurrentTool("select");
  }

  override onInterrupt() {
    this.cleanup();
  }

  private cleanup() {
    if (this.previewId) {
      if (this.editor.getShape(this.previewId)) {
        this.editor.deleteShapes([this.previewId]);
      }
      this.previewId = null;
    }
  }

  override onPointerUp(_info: TLPointerEventInfo) {
    if (!this.previewId) return;

    const preview = this.editor.getShape(this.previewId);
    this.editor.deleteShapes([this.previewId]);
    this.previewId = null;

    if (!preview) {
      this.editor.setCurrentTool("select");
      return;
    }

    const px = (preview as { x: number }).x;
    const py = (preview as { y: number }).y;
    const pw = (preview as { props: { w: number } }).props.w;
    const ph = (preview as { props: { h: number } }).props.h;

    const finalW = Math.max(pw, 240);
    const finalH = Math.max(ph, 180);

    const ctx = _contextByEditor.get(this.editor);
    if (!ctx) {
      console.warn("[tldraw4] NewDocTool: context not set for this editor");
      this.editor.setCurrentTool("select");
      return;
    }

    const datatypeId = _selectedDatatypeId;
    if (!datatypeId) {
      console.warn("[tldraw4] NewDocTool: no datatype selected");
      this.editor.setCurrentTool("select");
      return;
    }

    const editor = this.editor;
    const repo = ctx.repo;
    const placeholderId = createShapeId();

    editor.createShape({
      id: placeholderId,
      type: PATCHWORK_DOC_SHAPE_TYPE,
      x: px,
      y: py,
      rotation: 0,
      parentId: editor.getCurrentPageId(),
      props: {
        w: finalW,
        h: finalH,
        docUrl: "",
        docName: "Creating\u2026",
        docType: datatypeId,
        toolId: "",
      },
    });

    editor.setCurrentTool("select");
    editor.setSelectedShapes([placeholderId]);

    void (async () => {
      try {
        const datatype = await loadDatatype(datatypeId);
        if (!datatype) throw new Error(`Could not load datatype: ${datatypeId}`);

        // `createDocOfDatatype2` in the installed plugins package is typed
        // against an older @automerge/automerge-repo Repo; cast to bridge the
        // version skew (same pattern used by the space / llm-canvas tools).
        const docHandle = await (
          createDocOfDatatype2 as (d: LoadedDatatype, r: unknown) => Promise<{ url: string }>
        )(datatype, repo);
        const docUrl = docHandle.url;
        const deterministicId = makeShapeId(docUrl);

        const tempShape = editor.getShape(placeholderId) as
          | { x: number; y: number; props: { w: number; h: number } }
          | undefined;
        const sx = tempShape?.x ?? px;
        const sy = tempShape?.y ?? py;
        const sw = tempShape?.props?.w ?? finalW;
        const sh = tempShape?.props?.h ?? finalH;

        if (editor.getShape(placeholderId)) {
          editor.deleteShapes([placeholderId]);
        }

        if (editor.getShape(deterministicId)) {
          editor.updateShape({
            id: deterministicId,
            type: PATCHWORK_DOC_SHAPE_TYPE,
            props: {
              docUrl,
              docName: datatype.name ?? datatypeId,
              docType: datatypeId,
              toolId: "",
            },
          });
        } else {
          editor.createShape({
            id: deterministicId,
            type: PATCHWORK_DOC_SHAPE_TYPE,
            x: sx,
            y: sy,
            rotation: 0,
            parentId: editor.getCurrentPageId(),
            props: {
              w: sw,
              h: sh,
              docUrl,
              docName: datatype.name ?? datatypeId,
              docType: datatypeId,
              toolId: "",
            },
          });
        }

        editor.setSelectedShapes([deterministicId]);
      } catch (err) {
        console.error("[tldraw4] new doc creation failed:", err);
        if (editor.getShape(placeholderId)) {
          editor.updateShape({
            id: placeholderId,
            type: PATCHWORK_DOC_SHAPE_TYPE,
            props: { docName: `Error creating ${datatypeId}` },
          });
        }
      }
    })();
  }
}

export const newDocUiOverrides: TLUiOverrides = {
  tools(editor: Editor, tools: TLUiToolsContextType) {
    tools["new-doc"] = {
      id: "new-doc",
      icon: "plus",
      label: "New document",
      kbd: "c",
      onSelect() {
        editor.setCurrentTool("new-doc");
      },
    };
    return tools;
  },
};

export function NewDocToolbar() {
  const editor = useEditor();
  const isActive = useValue("new-doc active", () => editor.getCurrentToolId() === "new-doc", [
    editor,
  ]);

  const [datatypes, setDatatypes] = useState<DatatypeDescription[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(_selectedDatatypeId);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dt = getListedDatatypeDescriptions();
    setDatatypes(dt);
    if (dt.length > 0 && !_selectedDatatypeId) {
      setSelectedDatatypeId(dt[0].id);
      setSelectedId(dt[0].id);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: PointerEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [menuOpen]);

  const openMenu = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setDatatypes(getListedDatatypeDescriptions());
    setMenuOpen(true);
  }, []);

  const handlePlusClick = useCallback(() => {
    if (datatypes.length > 0 && !_selectedDatatypeId) {
      setSelectedDatatypeId(datatypes[0].id);
      setSelectedId(datatypes[0].id);
    }
    editor.setCurrentTool("new-doc");
    if (datatypes.length > 1) {
      if (menuOpen) setMenuOpen(false);
      else requestAnimationFrame(openMenu);
    }
  }, [datatypes, editor, menuOpen, openMenu]);

  const handlePick = useCallback(
    (id: string) => {
      setSelectedDatatypeId(id);
      setSelectedId(id);
      setMenuOpen(false);
      editor.setCurrentTool("new-doc");
    },
    [editor],
  );

  if (datatypes.length === 0) {
    return (
      <DefaultToolbar>
        <DefaultToolbarContent />
      </DefaultToolbar>
    );
  }

  const selectedName = datatypes.find((d) => d.id === selectedId)?.name ?? "document";

  return (
    <DefaultToolbar>
      <DefaultToolbarContent />

      <div style={{ width: "1px", height: "20px", background: "#ddd", margin: "0 4px", flexShrink: 0 }} />

      <div
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={handlePlusClick}
          title={`New document (${selectedName})`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            border: "none",
            borderRadius: "6px",
            background: isActive || menuOpen ? "var(--color-selected, #e8f0fe)" : "transparent",
            cursor: "pointer",
            color: isActive || menuOpen ? "var(--color-selected-contrast, #2f80ed)" : "currentColor",
            flexShrink: 0,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        {menuOpen &&
          menuPos &&
          datatypes.length > 1 &&
          createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                left: menuPos.x,
                top: menuPos.y,
                transform: "translate(-50%, -100%)",
                marginTop: "-8px",
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                padding: "4px",
                minWidth: "160px",
                zIndex: 100000,
              }}
            >
              {datatypes.map((dt) => (
                <button
                  key={dt.id}
                  type="button"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handlePick(dt.id);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "6px 10px",
                    border: "none",
                    borderRadius: "4px",
                    background: dt.id === selectedId ? "#e8f0fe" : "transparent",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                    color: "#333",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dt.name}
                </button>
              ))}
            </div>,
            document.body,
          )}
      </div>
    </DefaultToolbar>
  );
}
