import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import { render } from "solid-js/web";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { makeDocumentProjection } from "solid-automerge";
import { OpenDocumentEvent } from "@inkandswitch/patchwork-elements";
import {
  getRegistry,
  type ToolDescription,
  type ToolImplementation,
} from "@inkandswitch/patchwork-plugins";
import {
  type PatchworkToolProps,
  type HistoryDoc,
  type HistoryEntry,
} from "./types.ts";
import "./index.css";

type GroupingMode = "date" | "document";
type DocumentSortMode = "recent" | "visits";

const dateGroupFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Helper function to get tool metadata from registry
function getToolMetadata(toolId: string): { name: string; icon?: string } {
  const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");
  const tool = toolRegistry.get(toolId);

  if (tool) {
    return {
      name: tool.name || toolId,
      icon: tool.icon,
    };
  }

  // Fallback if tool not found in registry
  return {
    name: toolId,
    icon: "File",
  };
}

function HistoryEntryRow(props: {
  entry: HistoryEntry;
  timeDisplay: string;
  urlDisplay: string;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (e: MouseEvent, entry: HistoryEntry) => void;
}) {
  const toolMetadata = getToolMetadata(props.entry.toolId);

  return (
    <div class="account-history-entry">
      <div class="account-history-entry-time">{props.timeDisplay}</div>
      <div
        class="account-history-entry-content"
        onClick={() => props.onOpen(props.entry)}
      >
        <span class="account-history-entry-title">{props.entry.docTitle}</span>
        <span class="account-history-entry-tool">— {toolMetadata.name}</span>
        <span class="account-history-entry-url">{props.urlDisplay}</span>
      </div>
      <div class="account-history-entry-actions">
        <button
          class="account-history-entry-delete"
          onClick={(e) => props.onDelete(e, props.entry)}
          aria-label="Delete from history"
          title="Delete from history"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function HistoryViewer(props: PatchworkToolProps<HistoryDoc>) {
  const historyDoc = makeDocumentProjection<HistoryDoc>(props.handle);

  // Load preferences from localStorage
  const savedGroupingMode = (localStorage.getItem("history-grouping-mode") ||
    "date") as GroupingMode;
  const savedSortMode = (localStorage.getItem("history-document-sort-mode") ||
    "recent") as DocumentSortMode;
  const savedSearchQuery = localStorage.getItem("history-search-query") || "";

  const [groupingMode, setGroupingMode] =
    createSignal<GroupingMode>(savedGroupingMode);
  const [documentSortMode, setDocumentSortMode] =
    createSignal<DocumentSortMode>(savedSortMode);
  const [searchQuery, setSearchQuery] = createSignal<string>(savedSearchQuery);
  const [expandedGroups, setExpandedGroups] = createSignal<Set<AutomergeUrl>>(
    new Set()
  );

  // Save preferences to localStorage when they change
  createEffect(() => {
    localStorage.setItem("history-grouping-mode", groupingMode());
  });

  createEffect(() => {
    localStorage.setItem("history-document-sort-mode", documentSortMode());
  });

  createEffect(() => {
    localStorage.setItem("history-search-query", searchQuery());
  });

  // Filter entries based on search query
  const filteredEntries = createMemo(() => {
    const query = searchQuery().toLowerCase().trim();
    if (!query) {
      return historyDoc.entries || [];
    }

    return (historyDoc.entries || []).filter((entry) => {
      const titleMatch = entry.docTitle?.toLowerCase().includes(query);
      const urlMatch = entry.docUrl?.toLowerCase().includes(query);
      return titleMatch || urlMatch;
    });
  });

  // Group entries by date (returns array of [dateString, entries] tuples)
  const groupedByDate = createMemo(() => {
    const groups = new Map<string, HistoryEntry[]>();

    // Reverse to show most recent first
    const entries = [...filteredEntries()].reverse();

    for (const entry of entries) {
      const date = dateGroupFormatter.format(new Date(entry.timestamp));

      if (!groups.has(date)) {
        groups.set(date, []);
      }
      groups.get(date)!.push(entry);
    }

    return Array.from(groups);
  });

  // Group entries by document
  const groupedByDocument = createMemo(() => {
    const groups = new Map<AutomergeUrl, HistoryEntry[]>();

    // Reverse to show most recent first within each document group
    const entries = [...filteredEntries()].reverse();

    for (const entry of entries) {
      if (!groups.has(entry.docUrl)) {
        groups.set(entry.docUrl, []);
      }
      groups.get(entry.docUrl)!.push(entry);
    }

    return groups;
  });

  // Sorted document groups
  const sortedDocumentGroups = createMemo(() => {
    const groups = Array.from(groupedByDocument());
    const sortMode = documentSortMode();

    if (sortMode === "visits") {
      // Sort by number of visits (descending)
      return groups.sort((a, b) => b[1].length - a[1].length);
    } else {
      // Precompute max timestamps to avoid recalculating in comparator
      const maxTimestamps = new Map<AutomergeUrl, number>();
      for (const [url, entries] of groups) {
        let max = 0;
        for (const e of entries) {
          if (e.timestamp > max) max = e.timestamp;
        }
        maxTimestamps.set(url, max);
      }
      return groups.sort(
        (a, b) => maxTimestamps.get(b[0])! - maxTimestamps.get(a[0])!
      );
    }
  });

  const openDocument = (entry: HistoryEntry) => {
    // TODO: it makes sense to load the document at the specific moment in history, but for now
    // this isn't indicated well in the UI, so it's likely to be confusing.
    // const url =
    //   entry.heads.length > 0
    //     ? (`${entry.docUrl}#${entry.heads[0]}` as AutomergeUrl)
    //     : entry.docUrl;
    const url = entry.docUrl;

    // Open document with saved tool
    props.element.dispatchEvent(
      new OpenDocumentEvent({
        url,
        toolId: entry.toolId,
      })
    );
  };

  const formatTime = (timestamp: number) => {
    return timeFormatter.format(new Date(timestamp));
  };

  const formatShortDate = (timestamp: number) => {
    return shortDateFormatter.format(new Date(timestamp));
  };

  const deleteEntry = (e: MouseEvent, entryToDelete: HistoryEntry) => {
    e.stopPropagation();

    props.handle.change((doc) => {
      const index = doc.entries.findIndex(
        (e) =>
          e.timestamp === entryToDelete.timestamp &&
          e.docUrl === entryToDelete.docUrl
      );
      if (index !== -1) {
        doc.entries.splice(index, 1);
      }
    });
  };

  const toggleGroup = (docUrl: AutomergeUrl) => {
    setExpandedGroups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(docUrl)) {
        newSet.delete(docUrl);
      } else {
        newSet.add(docUrl);
      }
      return newSet;
    });
  };

  const openDocumentGroup = (docUrl: AutomergeUrl) => {
    // Open document without specifying heads or tool (opens most recent version with default tool)
    props.element.dispatchEvent(
      new OpenDocumentEvent({
        url: docUrl,
      })
    );
  };

  return (
    <div class="account-history-viewer">
      <div class="account-history-header">
        <h1 class="account-history-title">Account History</h1>
        <div class="account-history-header-controls">
          <span class="account-history-group-label">Group by:</span>
          <button
            onClick={() => setGroupingMode("date")}
            class={`account-history-toggle-button ${groupingMode() === "date" ? "active" : ""}`}
          >
            Date
          </button>
          <button
            onClick={() => setGroupingMode("document")}
            class={`account-history-toggle-button ${groupingMode() === "document" ? "active" : ""}`}
          >
            Document
          </button>
          <Show when={groupingMode() === "document"}>
            <span class="account-history-sort-label">Sort by:</span>
            <button
              onClick={() => setDocumentSortMode("recent")}
              class={`account-history-sort-button ${documentSortMode() === "recent" ? "active" : ""}`}
            >
              Most Recent
            </button>
            <button
              onClick={() => setDocumentSortMode("visits")}
              class={`account-history-sort-button ${documentSortMode() === "visits" ? "active" : ""}`}
            >
              Most Visits
            </button>
          </Show>
        </div>
        <div class="account-history-search">
          <svg
            class="account-history-search-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            class="account-history-search-input"
            placeholder="search history"
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      <div class="account-history-content">
        <Show when={groupingMode() === "date"}>
          <For each={groupedByDate()}>
            {([date, entries]) => (
              <div class="account-history-group">
                <div class="account-history-group-header">
                  <h2 class="account-history-group-title">{date}</h2>
                </div>
                <div class="account-history-entries">
                  <For each={entries}>
                    {(entry) => (
                      <HistoryEntryRow
                        entry={entry}
                        timeDisplay={formatTime(entry.timestamp)}
                        urlDisplay={entry.docUrl}
                        onOpen={openDocument}
                        onDelete={deleteEntry}
                      />
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>

        <Show when={groupingMode() === "document"}>
          <For each={sortedDocumentGroups()}>
            {([docUrl, entries]) => {
              const isExpanded = () => expandedGroups().has(docUrl);

              return (
                <div class="account-history-group">
                  <div
                    class="account-history-group-header account-history-group-header-clickable"
                    onClick={() => openDocumentGroup(docUrl)}
                  >
                    <div class="account-history-group-header-content">
                      <h2 class="account-history-group-title">
                        {entries[0]?.docTitle ?? "Untitled"}
                      </h2>
                      <p class="account-history-group-meta">
                        {entries[0]?.docType ?? "unknown"} • {entries.length}{" "}
                        {entries.length === 1 ? "visit" : "visits"}
                      </p>
                    </div>
                    <button
                      class="account-history-group-toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroup(docUrl);
                      }}
                      aria-label={isExpanded() ? "Collapse" : "Expand"}
                      title={isExpanded() ? "Collapse" : "Expand"}
                    >
                      {isExpanded() ? "−" : "+"}
                    </button>
                  </div>
                  <Show when={isExpanded()}>
                    <div class="account-history-entries">
                      <For each={entries}>
                        {(entry) => (
                          <HistoryEntryRow
                            entry={entry}
                            timeDisplay={formatShortDate(entry.timestamp)}
                            urlDisplay={`(#${entry.heads})`}
                            onOpen={openDocument}
                            onDelete={deleteEntry}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={!historyDoc.entries || historyDoc.entries.length === 0}>
          <div class="account-history-empty">
            No history yet. Open some documents to start tracking your history.
          </div>
        </Show>
      </div>
    </div>
  );
}

export const renderHistoryViewer: ToolImplementation<HistoryDoc> = (
  handle,
  element
) => render(() => <HistoryViewer handle={handle} repo={element.repo} element={element} />, element);
