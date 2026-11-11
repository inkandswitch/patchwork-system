// Embed frame: chrome (title, tool picker, open button) around a nested
// <patchwork-view>. Hosts mount it via <patchwork-view tool-id="embed">, pin
// the inner tool with the `embed-tool-id` attribute, and persist picks by
// listening for the bubbling `patchwork:embed-tool-changed` event.

import {
  getFallbackTool,
  getRegistry,
  getSupportedToolsForType,
  isLoadedPlugin,
  type DatatypeImplementation,
  type ToolDescription,
  type ToolImplementation,
} from "@inkandswitch/patchwork-plugins";
import { getType } from "@inkandswitch/patchwork-filesystem";
import { openDocument } from "@inkandswitch/patchwork-elements";
import type { DocHandle } from "@automerge/automerge-repo";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { version } from "../package.json";
import "./embed.css";

const EMBED_TOOL_ID = "embed";

const EmbedFrame: ToolImplementation<any> = (handle, element) =>
  render(() => <Frame handle={handle} element={element} />, element);

export default EmbedFrame;

type FrameProps = {
  handle: DocHandle<any>;
  element: HTMLElement;
};

function Frame(props: FrameProps) {
  // Static per mount (the render contract passes them once); safe to unwrap.
  const { handle, element } = props;

  // `element` is the inner <patchwork-view-legacy>; hosts set `embed-tool-id`
  // on the outer <patchwork-view>, so check there too.
  const [pinnedToolId, setPinnedToolId] = createSignal(
    element.getAttribute("embed-tool-id") ||
      element.closest("patchwork-view")?.getAttribute("embed-tool-id") ||
      null
  );
  const [doc, setDoc] = createSignal<any>(handle.doc(), { equals: false });
  const [datatype, setDatatype] =
    createSignal<DatatypeImplementation<any> | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const onDocChange = () => setDoc(handle.doc());
  handle.on("change", onDocChange);
  onCleanup(() => handle.off("change", onDocChange));
  void loadDatatype();

  let menuEl!: HTMLDivElement;
  let toolButtonEl!: HTMLButtonElement;

  const title = () => {
    try {
      return datatype()?.getTitle(doc()) || "Untitled";
    } catch {
      // getTitle throws on unexpected doc shapes
      return "Untitled";
    }
  };

  const canRename = () => Boolean(datatype()?.setTitle);

  // With no pinned tool the nested view renders the doc's fallback tool, so
  // surface that as the selection rather than a special "unselected" state.
  const effectiveToolId = () => {
    datatype(); // re-check once the datatype (and the tools it ships) loaded
    if (pinnedToolId()) return pinnedToolId();
    try {
      return getFallbackTool(doc())?.id ?? null;
    } catch {
      return null;
    }
  };

  const toolName = () => {
    const toolId = effectiveToolId();
    if (!toolId) return "";
    const tool = getRegistry<ToolDescription>("patchwork:tool").get(toolId);
    return tool?.name ?? toolId;
  };

  function setTool(toolId: string): void {
    if (!toolId || toolId === pinnedToolId()) return;
    setPinnedToolId(toolId);
    element.dispatchEvent(
      new CustomEvent("patchwork:embed-tool-changed", {
        detail: { url: handle.url, toolId },
        bubbles: true,
        composed: true,
      })
    );
  }

  function finishRename(commit: boolean, value: string): void {
    if (!renaming()) return;
    setRenaming(false);
    const trimmed = value.trim();
    if (commit && trimmed && trimmed !== title()) {
      handle.change((d: any) => datatype()!.setTitle!(d, trimmed));
    }
  }

  function toggleMenu(): void {
    if (menuEl.matches(":popover-open")) {
      menuEl.hidePopover();
      return;
    }
    setMenuOpen(true);
    const rect = toolButtonEl.getBoundingClientRect();
    const menuWidth = Math.max(rect.width, 180);
    menuEl.style.top = `${rect.bottom + 2}px`;
    menuEl.style.minWidth = `${menuWidth}px`;
    if (rect.left + menuWidth > window.innerWidth - 8) {
      menuEl.style.left = "";
      menuEl.style.right = `${window.innerWidth - rect.right}px`;
      menuEl.style.transformOrigin = "top right";
    } else {
      menuEl.style.right = "";
      menuEl.style.left = `${rect.left}px`;
      menuEl.style.transformOrigin = "top left";
    }
    menuEl.showPopover();
  }

  function listTools(): ToolDescription[] {
    const d = doc();
    const type = d && getType(d);
    if (!type) return [];
    const list = getSupportedToolsForType(type).filter(
      (t) => !t.unlisted && !t.forTitleBar && t.id !== EMBED_TOOL_ID
    );
    // Datatype-specific tools before the generic wildcard ones.
    list.sort((a, b) => Number(isWildcard(a)) - Number(isWildcard(b)));
    return list;
  }

  // Built imperatively rather than as JSX so we don't have to teach Solid's
  // JSX types about the custom element.
  const nestedView = document.createElement("patchwork-view");
  nestedView.setAttribute("doc-url", handle.url);
  createEffect(() => {
    const toolId = pinnedToolId();
    if (toolId) nestedView.setAttribute("tool-id", toolId);
    else nestedView.removeAttribute("tool-id");
  });

  // Load the datatype (for getTitle/setTitle and its tools).
  async function loadDatatype(): Promise<void> {
    const d = handle.doc();
    const type = d && getType(d);
    if (!type) return;
    const registry = getRegistry("patchwork:datatype");
    try {
      await registry.load(type);
    } catch {
      // datatype unavailable; keep the fallbacks
    }
    const loaded = registry.get(type);
    if (loaded && isLoadedPlugin(loaded)) {
      setDatatype(() => loaded.module as DatatypeImplementation<any>);
    }
  }

  return (
    <div class="embed-frame">
      <div class="header">
        <Show
          when={!renaming()}
          fallback={
            <input
              class="rename-input"
              value={title()}
              ref={(el) =>
                queueMicrotask(() => {
                  el.focus();
                  el.select();
                })
              }
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") finishRename(true, e.currentTarget.value);
                if (e.key === "Escape")
                  finishRename(false, e.currentTarget.value);
              }}
              onBlur={(e) => finishRename(true, e.currentTarget.value)}
            />
          }
        >
          <span
            class="title"
            data-renamable={canRename() ? "" : undefined}
            title={canRename() ? "Click to rename" : undefined}
            onClick={() => canRename() && setRenaming(true)}
          >
            {title()}
          </span>
        </Show>
        {/* Deploy check: which build is actually running. */}
        <span class="version">v{version}</span>
        <button
          class="tool-btn"
          title={"Open with\u2026"}
          ref={toolButtonEl}
          onClick={toggleMenu}
        >
          {toolName()}
        </button>
        <button
          class="open-btn"
          title="Open document"
          innerHTML={openIcon}
          onClick={() =>
            openDocument(element, handle.url, pinnedToolId() || undefined)
          }
        />
      </div>
      <div class="content">{nestedView}</div>
      <div
        class="tool-menu"
        popover="auto"
        ref={(el) => {
          menuEl = el;
          // Unrender the item list while closed.
          el.addEventListener("toggle", (e) => {
            if ((e as { newState?: string }).newState === "closed") {
              setMenuOpen(false);
            }
          });
        }}
      >
        <Show when={menuOpen()}>
          <div class="list">
            <For each={listTools()}>
              {(tool) => (
                <button
                  class="item"
                  data-current={tool.id === effectiveToolId() ? "" : undefined}
                  onClick={() => {
                    menuEl.hidePopover();
                    setTool(tool.id);
                  }}
                >
                  {tool.name || tool.id}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function isWildcard(tool: ToolDescription): boolean {
  return (
    tool.supportedDatatypes === "*" ||
    (Array.isArray(tool.supportedDatatypes) &&
      tool.supportedDatatypes.includes("*"))
  );
}

const openIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
	<polyline points="15 3 21 3 21 9"></polyline>
	<line x1="10" y1="14" x2="21" y2="3"></line>
</svg>`;
