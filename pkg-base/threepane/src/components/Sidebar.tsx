import { Show, type Accessor, type JSX } from "solid-js";
import type { SidebarSide } from "../hooks";

type SidebarProps = {
  side: SidebarSide;
  isCollapsed: Accessor<boolean>;
  width: Accessor<number>;
  onMouseDown: (e: MouseEvent) => void;
  onToggleClick: (e: MouseEvent) => void;
  canExpand?: Accessor<boolean>;
  children?: JSX.Element;
};

/**
 * Sidebar shell for the left and right sidebars: owns the collapse/resize chrome
 * and renders `children` while open. The content is unmounted while collapsed
 * and rebuilt on re-expand, so anything holding a ref into it must rebind.
 * Props are accessed via `props.x` (not destructured) to preserve Solid reactivity.
 */
export function Sidebar(props: SidebarProps) {
  // Collapsed sidebars shrink to zero width. The resize/toggle button still
  // renders and straddles the edge (it reserves no layout column), so it stays
  // grabbable as a drag-to-reopen handle even at 0px.
  const widthStyle = () => `${props.isCollapsed() ? 0 : props.width()}px`;
  const canExpand = () => props.canExpand?.() ?? true;

  const content = () => <Show when={!props.isCollapsed()}>{props.children}</Show>;

  const handle = () => (
    <Show when={!props.isCollapsed() || canExpand()}>
      <button
        onClick={(e) => props.onToggleClick(e)}
        onMouseDown={(e) => props.onMouseDown(e)}
        class="sidebar-toggle sidebar-toggle--resizable"
        aria-label={
          props.isCollapsed() ? "Expand sidebar" : "Toggle or resize sidebar"
        }
        title={
          props.isCollapsed()
            ? "Click to expand, drag to resize"
            : "Click to toggle, drag to resize"
        }
      />
    </Show>
  );

  // The handle sits on the sidebar's inner edge: after the content on the left,
  // before it on the right.
  return (
    <div
      class="sidebar"
      data-side={props.side}
      data-collapsed={props.isCollapsed() ? "" : undefined}
      style={{ width: widthStyle() }}
    >
      {props.side === "left" ? (
        <>
          {content()}
          {handle()}
        </>
      ) : (
        <>
          {handle()}
          {content()}
        </>
      )}
    </div>
  );
}
