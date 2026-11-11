import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import { useTaggedComponents } from "../hooks";
import { Sidebar } from "./Sidebar";
import { ContextTabs } from "./ContextTabs";

type ContextSidebarProps = {
  /**
   * Selected tab, owned by the frame *above* the branch-switch boundary so it
   * survives document and branch switches.
   */
  selectedToolId: Accessor<string | undefined>;
  setSelectedToolId: (id: string) => void;
  isCollapsed: Accessor<boolean>;
  width: Accessor<number>;
  onMouseDown: (e: MouseEvent) => void;
  onToggleClick: (e: MouseEvent) => void;
  canExpand?: Accessor<boolean>;
  /** Collapse the sidebar, from its own tab-header button. */
  onCollapse: () => void;
};

/**
 * The document context sidebar: a full-height column with its own tab header
 * (the tabs that select the active tool, plus a collapse button), and the
 * active context tool's content.
 *
 * The tab list is every `patchwork:component` tagged `"context-tool"` —
 * registry-driven, not configured — so it's always rendered as a bare
 * component with no document.
 */
export function ContextSidebar(props: ContextSidebarProps) {
  const items = useTaggedComponents("context-tool");

  // The selection may name a tool that isn't in the current list (or be unset);
  // fall back to the first tab so there's always a valid active tool.
  const activeToolId = () => {
    const ids = items().map((item) => item.id);
    const selected = props.selectedToolId();
    return selected && ids.includes(selected) ? selected : ids[0];
  };

  return (
    <Sidebar
      side="right"
      isCollapsed={props.isCollapsed}
      width={props.width}
      onMouseDown={props.onMouseDown}
      onToggleClick={props.onToggleClick}
      canExpand={props.canExpand}
    >
      <div class="context-sidebar">
        {/* Tab header: selects the active tool, with a collapse button at the
            end. Only when there are tabs — a tray-only sidebar has no header
            and is collapsed via the resize handle. */}
        <Show when={items().length}>
          <div class="context-sidebar__tabs">
            <ContextTabs
              items={items}
              selectedToolId={props.selectedToolId}
              setSelectedToolId={props.setSelectedToolId}
            />
            <button
              type="button"
              class="context-sidebar__close"
              title="Hide context sidebar"
              aria-label="Hide context sidebar"
              onClick={() => props.onCollapse()}
            >
              <PanelRightIcon />
            </button>
          </div>
        </Show>
        <Show when={!props.isCollapsed()}>
          <div class="context-sidebar__content">
            <Show when={activeToolId()} keyed>
              {(id) => <patchwork-view component={id} />}
            </Show>
          </div>
        </Show>
      </div>
    </Sidebar>
  );
}

// lucide `panel-right`
export function PanelRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--studio-chrome-line)"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}
