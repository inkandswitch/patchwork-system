import { onMount, onCleanup, createEffect } from "solid-js";
import { render } from "solid-js/web";
import { type AutomergeUrl } from "@automerge/automerge-repo/slim";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import "./index.css";
import { OpenDocumentEvent } from "@inkandswitch/patchwork-elements";
import {
  getType,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import {
  getFallbackTool,
  getRegistry,
  type DatatypeDescription,
  type DatatypeImplementation,
} from "@inkandswitch/patchwork-plugins";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import {
  ACCOUNT_HISTORY_DATATYPE,
  DEDUPLICATION_TIME_THRESHOLD,
  VIEWER_TOOL_ID,
} from "./constants.ts";
import {
  type PatchworkToolProps,
  type HistoryDoc,
  type HistoryEntry,
} from "./types.ts";

// Key under which this tool's private storage doc is registered — see the
// `patchwork:tool-storage` provider (patchwork-base/providers). Mounted as a
// titlebar-tool, this component is bound to whatever *document* is focused,
// not the account, so it can't reach its own storage via `props.handle`; the
// provider gives it a private, account-scoped doc instead.
const TOOL_STORAGE_ID = "account-history";

export function HistoryRecorder(props: PatchworkToolProps<any>) {
  // Resolves (and, on first use, creates) this tool's private storage doc.
  // The provider only guarantees an empty doc exists — the shape below
  // (`entries`, `title`, `@patchwork`) is seeded by us the first time it's
  // used.
  const [historyDoc, historyHandle] = subscribeDoc<HistoryDoc>(
    props.element,
    { type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID }
  );

  const historyUrl = () => historyHandle()?.url;

  createEffect(() => {
    const handle = historyHandle();
    const doc = historyDoc();
    if (!handle || !doc || Array.isArray(doc.entries)) return;
    handle.change((d) => {
      if (Array.isArray(d.entries)) return; // lost an initialization race
      d["@patchwork"] = { type: ACCOUNT_HISTORY_DATATYPE };
      d.title = "Account History";
      d.entries = [];
    });
  });

  onMount(() => {
    const onDocumentOpened = async (event: Event) => {
      const openEvent = event as OpenDocumentEvent;
      const { url: rawUrl, toolId: rawToolId } = openEvent.detail;
      const [docUrl, ...heads] = rawUrl.split("#");
      const url = docUrl as AutomergeUrl;
      let toolId = rawToolId;

      // Get document to extract title and type
      const docHandle = await props.repo.find(url);
      const doc = docHandle.doc();

      if (!doc) {
        console.warn("HistoryRecorder: failed to load document");
        return;
      }

      const datatype = getType(doc as Partial<HasPatchworkMetadata>);

      if (!toolId) {
        // if the tool id isn't defined, use the current fallback tool
        if (!datatype) {
          console.warn(
            "HistoryRecorder: no tool found for document type; skipping history recording"
          );
          return;
        }
        const fallbackTool = getFallbackTool(doc as HasPatchworkMetadata);
        if (!fallbackTool) {
          console.warn(
            "HistoryRecorder: no tool found for document type; skipping history recording"
          );
          return;
        }
        toolId = fallbackTool.id;
      }

      if (datatype === ACCOUNT_HISTORY_DATATYPE) {
        return; // Don't record when opening account history documents
      }

      const currentHistoryHandle = historyHandle();
      if (!currentHistoryHandle) {
        console.warn("HistoryRecorder: history handle not ready yet");
        return;
      }
      const historyDocSnapshot = currentHistoryHandle.doc();
      if (!historyDocSnapshot) {
        console.warn("HistoryRecorder: history document not ready yet");
        return;
      }

      // Deduplication: check if this entry is a duplicate from rapid clicks
      const lastEntry =
        historyDocSnapshot.entries[historyDocSnapshot.entries.length - 1];
      if (
        lastEntry &&
        lastEntry.docUrl === url &&
        lastEntry.toolId === toolId &&
        Date.now() - lastEntry.timestamp < DEDUPLICATION_TIME_THRESHOLD
      ) {
        return; // Skip recording - duplicate from rapid clicking
      }

      // Extract title
      let docTitle = "Untitled";
      if (datatype) {
        const registry = getRegistry<DatatypeDescription>("patchwork:datatype");
        const loaded = registry.get(datatype);
        if (loaded && "module" in loaded) {
          const impl = loaded.module as DatatypeImplementation;
          try {
            docTitle = impl.getTitle(doc) || "Untitled";
          } catch {
            // getTitle may fail if the document shape doesn't match the datatype
          }
        }
      }

      // Get current heads, unless the URL specified a head
      let entryHeads = heads;
      if (entryHeads.length === 0) entryHeads = docHandle.heads();

      // Create new entry
      const newEntry: HistoryEntry = {
        timestamp: Date.now(),
        docUrl: url,
        docTitle,
        docType: datatype || "unknown",
        toolId,
        heads: entryHeads,
      };

      // Add entry to history
      currentHistoryHandle.change((doc) => {
        doc.entries.push(newEntry);
      });
    };

    // Listen to patchwork:open-document events (should fire once per user action)
    document.addEventListener(
      "patchwork:open-document",
      onDocumentOpened as EventListener,
      { capture: true }
    );

    onCleanup(() => {
      document.removeEventListener(
        "patchwork:open-document",
        onDocumentOpened as EventListener,
        { capture: true }
      );
    });
  });

  const openHistory = () => {
    const currentHistoryUrl = historyUrl();
    if (!currentHistoryUrl) {
      console.warn("HistoryRecorder: no history URL yet");
      return;
    }

    // Dispatch open document event
    props.element.dispatchEvent(
      new OpenDocumentEvent({
        url: currentHistoryUrl,
        toolId: VIEWER_TOOL_ID,
      })
    );
  };

  return (
    <button
      onClick={openHistory}
      class="account-history-toolbar-button"
      title="Open account history"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </button>
  );
}

export const renderHistoryRecorder: ToolImplementation<any> = (
  handle,
  element
) => render(() => <HistoryRecorder handle={handle} repo={element.repo} element={element} />, element);
