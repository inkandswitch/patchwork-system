import { For, createMemo } from "solid-js";
import type { HistoryItem as HistoryItemType } from "../../types";
import { isItemSelected } from "../../types";
import { computeChangeSizeThresholds, type ChangeSizeThresholds } from "../utils";
import { HistoryItem } from "./HistoryItem";
import { DateHeader } from "./DateHeader";

export interface HistoryListProps {
  items: HistoryItemType[];
  selectedItems: HistoryItemType[];
  onSelectItem: (item: HistoryItemType, shiftHeld: boolean) => void;
  onRenameItem: (hash: string, label: string) => void;
}

interface GroupedByDate {
  date: Date;
  items: HistoryItemType[];
}

/**
 * Get the date (without time) from a history item
 */
function getItemDate(item: HistoryItemType): Date | null {
  const timestamp = item.endTime;
  if (!timestamp) return null;

  const date = new Date(timestamp * 1000);
  // Reset time to midnight for grouping
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Scrollable list container for history items.
 * Groups items by date and shows date headers.
 */
export function HistoryList(props: HistoryListProps) {
  const thresholds = createMemo<ChangeSizeThresholds>(() => {
    const allItems = props.items.flatMap(item => [item, ...(item.subItems ?? [])]);
    return computeChangeSizeThresholds(allItems);
  });

  // Group items by date
  const groupedItems = createMemo<GroupedByDate[]>(() => {
    const groups: Map<string, GroupedByDate> = new Map();

    props.items.forEach((item) => {
      const date = getItemDate(item);
      if (!date) return;

      const dateKey = date.toISOString();
      if (!groups.has(dateKey)) {
        groups.set(dateKey, { date, items: [] });
      }
      groups.get(dateKey)!.items.push(item);
    });

    // Convert to array and sort by date (newest first)
    return Array.from(groups.values()).sort(
      (a, b) => b.date.getTime() - a.date.getTime()
    );
  });

  return (
    <div class="history-list" style={{ "min-height": "0" }}>
      <For each={groupedItems()}>
        {(group) => (
          <>
            <DateHeader date={group.date} />
            <div style={{ display: "flex", "flex-direction": "column", gap: "0.5rem", padding: "0 0.5rem 1rem" }}>
              <For each={group.items}>
                {(item, index) => {
                  const isLast = () => index() === group.items.length - 1;
                  const isSelected = () =>
                    isItemSelected(item, props.selectedItems);

                  return (
                    <div class={isLast() ? "last-timeline-item" : ""}>
                      <HistoryItem
                        item={item}
                        isSelected={isSelected()}
                        thresholds={thresholds()}
                        onClick={(e) => props.onSelectItem(item, e.shiftKey)}
                        onRename={(label) => props.onRenameItem(item.latestHash, label)}
                        onSubItemClick={(subItem, e) => props.onSelectItem(subItem, e.shiftKey)}
                        isSubItemSelected={(subItem) => isItemSelected(subItem, props.selectedItems)}
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          </>
        )}
      </For>
    </div>
  );
}
