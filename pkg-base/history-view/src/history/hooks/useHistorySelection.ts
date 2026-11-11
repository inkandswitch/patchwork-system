import { createMemo, createSignal } from "solid-js";
import type { ViewHeadsType, HistoryItem } from "../../types";

export function useHistorySelection() {
  const [selectedItems, setSelectedItems] = createSignal<HistoryItem[]>([]);
  const [anchorItem, setAnchorItem] = createSignal<HistoryItem | null>(null);

  const selectItem = (item: HistoryItem) => {
    if (item.count === 0) {
      console.warn("Empty history item encountered");
      return;
    }
    setSelectedItems([item]);
    setAnchorItem(item);
  };

  /**
   * Extend the selection from the current anchor to `item`, using `allItems`
   * (ordered newest-first) to determine the contiguous range.
   */
  const extendSelection = (item: HistoryItem, allItems: HistoryItem[]) => {
    const anchor = anchorItem();
    if (!anchor) {
      selectItem(item);
      return;
    }

    const anchorIdx = allItems.findIndex((i) => i.id === anchor.id);
    const targetIdx = allItems.findIndex((i) => i.id === item.id);

    if (anchorIdx === -1 || targetIdx === -1) {
      selectItem(item);
      return;
    }

    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    setSelectedItems(allItems.slice(start, end + 1));
  };

  const clearSelection = () => {
    setSelectedItems([]);
    setAnchorItem(null);
  };

  const viewHeads = createMemo<ViewHeadsType | null>(() => {
    const items = selectedItems();
    if (items.length === 0) return null;

    // Find oldest (smallest startTime) and newest (largest endTime) in the selection.
    // The oldest item's beforeHead is the "before" boundary; the newest item's
    // latestHash is the "after" boundary.
    let oldest = items[0];
    let newest = items[0];
    for (const item of items) {
      if (item.startTime !== undefined && (oldest.startTime === undefined || item.startTime < oldest.startTime)) {
        oldest = item;
      }
      if (item.endTime !== undefined && (newest.endTime === undefined || item.endTime > newest.endTime)) {
        newest = item;
      }
    }

    return {
      beforeHeads: oldest.beforeHead ? [oldest.beforeHead] : [],
      afterHeads: [newest.latestHash],
    };
  });

  return {
    viewHeads,
    selectedItems,
    selectItem,
    extendSelection,
    clearSelection,
  };
}
