import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { type Accessor, Show } from "solid-js";
import { useDocument } from "solid-automerge";
import type { HasPatchworkMetadata } from "@inkandswitch/patchwork-filesystem";
import {
  useDocumentMetadata,
  useHistorySelection,
  useCachedHistory,
} from "../hooks";
import { type GroupingStrategyConfig, type HistoryItem } from "../../types";
import { DEFAULT_TIME_WINDOW } from "../utils";
import { DocHistoryHeader } from "./DocHistoryHeader";
import { HistoryList } from "./HistoryList";
import { HistoryComputingIndicator } from "./HistoryComputingIndicator";

export interface DocHistoryViewProps {
  url: AutomergeUrl;
  repo: Repo;
  /**
   * Whether to render the document's title in the header. Defaults to true;
   * pass an accessor returning `false` (e.g. when the sidebar is showing a
   * single doc whose title is already visible elsewhere) to suppress it
   * while keeping the reset button.
   */
  showTitle?: Accessor<boolean>;
}

const STRATEGY_CONFIG: GroupingStrategyConfig = {
  name: "timeWindow",
  params: { timeWindow: DEFAULT_TIME_WINDOW },
};
const strategyConfig = () => STRATEGY_CONFIG;

export function DocHistoryView(props: DocHistoryViewProps) {
  const [doc, handle] = useDocument<HasPatchworkMetadata>(props.url, {
    repo: props.repo,
  });

  const { title } = useDocumentMetadata(doc);

  const { items: groupedItems, isInitializing, isRecalculating, forceRecompute, setLabel } = useCachedHistory(
    handle,
    strategyConfig,
    props.repo
  );

  const { selectedItems, selectItem, extendSelection, clearSelection } = useHistorySelection();

  const handleSelectItem = (item: HistoryItem, shiftHeld: boolean) => {
    if (shiftHeld) {
      extendSelection(item, groupedItems());
    } else {
      selectItem(item);
    }
  };

  return (
    <div class="history-panel" style={{ flex: "1", "min-height": "0" }} onClick={clearSelection}>
      <DocHistoryHeader
        title={(props.showTitle?.() ?? true) ? title() : undefined}
        onRecompute={forceRecompute}
        isRecalculating={isRecalculating()}
      />
      <Show
        when={!isInitializing()}
        fallback={<HistoryComputingIndicator />}
      >
        <HistoryList
          items={groupedItems()}
          selectedItems={selectedItems()}
          onSelectItem={handleSelectItem}
          onRenameItem={setLabel}
        />
      </Show>
    </div>
  );
}
