import { For } from "solid-js";
import type { Accessor } from "solid-js";
import type { TaggedComponent } from "../hooks";

type ContextTabsProps = {
  items: Accessor<TaggedComponent[]>;
  selectedToolId: Accessor<string | undefined>;
  setSelectedToolId: (id: string) => void;
};

/**
 * The context sidebar's tab bar, lifted out of the sidebar and into the top
 * toolbar (it sits above the right sidebar). Horizontally scrollable when the
 * tabs overflow. Selection is owned by the frame so it survives branch switches.
 */
export function ContextTabs(props: ContextTabsProps) {
  const activeToolId = () => {
    const ids = props.items().map((item) => item.id);
    const selected = props.selectedToolId();
    return selected && ids.includes(selected) ? selected : ids[0];
  };

  return (
    <div role="tablist" class="context-sidebar__tablist">
      <For each={props.items()}>
        {(item) => (
          <button
            type="button"
            role="tab"
            class="context-sidebar__tab"
            data-active={activeToolId() === item.id ? "" : undefined}
            onClick={() => props.setSelectedToolId(item.id)}
          >
            {item.name}
          </button>
        )}
      </For>
    </div>
  );
}
