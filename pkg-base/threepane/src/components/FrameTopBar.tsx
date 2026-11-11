import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { For, Show, type Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { DocumentTitle } from "./DocumentTitle";
import { PanelRightIcon } from "./ContextSidebar";
import { slotId } from "./SlotView";

type FrameTopBarProps = {
  docUrl: Accessor<AutomergeUrl | undefined>;
  toolSlots: Accessor<ToolSlot[] | undefined>;

  isLeftCollapsed: Accessor<boolean>;

  /** Whether a context sidebar exists at all (tabs or tray) — gates the reopen
   *  toggle so we only offer it when there's something to reopen. */
  hasContext: Accessor<boolean>;
  isRightCollapsed: Accessor<boolean>;
  onToggleRight: () => void;
};

/**
 * The document column's top toolbar: the document title and tool views. Spans
 * the document column (left of the context sidebar, which carries its own tab
 * header); the left sidebar toggle is pinned separately to the frame's top-left
 * corner. When the left sidebar is collapsed the bar reserves a matching slot at
 * its start so the title slides up against (not under) that toggle. When the
 * context sidebar is collapsed a reopen toggle appears at the bar's right end.
 */
export function FrameTopBar(props: FrameTopBarProps) {
  // Title + spacer are intrinsic to the bar and never in the config (the
  // migration drops them), so the configured doctitle tools render as-is.
  const docToolSlots = () => props.toolSlots() ?? [];

  return (
    <div
      class="frame__topbar"
      classList={{ "frame__topbar--left-collapsed": props.isLeftCollapsed() }}
    >
      {/* document title, rendered intrinsically: shrinks to the title length,
          capped at half the bar. */}
      <Show when={props.docUrl()}>
        <div class="threepane__title">
          <DocumentTitle docUrl={props.docUrl} />
        </div>
      </Show>

      {/* built-in spacer */}
      <div class="threepane__spacer" />

      {/* configured doctitle tools, at the end on the right, scrollable.
          Unlike other lanes these always run against the currently selected
          main-view doc — they follow whatever document is open. Tuple and bare
          string are treated the same: take the slot's id as the tool, ignore
          any doc named in the tuple, and point it at the open doc. */}
      <Show when={props.docUrl() && docToolSlots().length}>
        <div class="threepane__doctitle-tools">
          <For each={docToolSlots()}>
            {(slot) => (
              <patchwork-view tool-id={slotId(slot)} doc-url={props.docUrl()} />
            )}
          </For>
        </div>
      </Show>

      {/* When the context sidebar is collapsed its own tab header is hidden, so
          the reopen affordance lives here at the bar's right end. When expanded
          the sidebar carries its own collapse button in its tab header. */}
      <Show when={props.hasContext() && props.isRightCollapsed()}>
        <button
          type="button"
          class="frame__sidebar-toggle"
          title="Show context sidebar"
          aria-label="Show context sidebar"
          aria-pressed={false}
          onClick={() => props.onToggleRight()}
        >
          <PanelRightIcon />
        </button>
      </Show>
    </div>
  );
}
