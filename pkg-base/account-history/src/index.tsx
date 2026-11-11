import { type ToolImplementation } from "@inkandswitch/patchwork-plugins";
import {
  ACCOUNT_HISTORY_DATATYPE,
  VIEWER_TOOL_ID,
  NOTEBOOK_VIEWER_TOOL_ID,
} from "./constants.ts";
import type { HistoryDoc } from "./types.ts";

export const plugins = [
  {
    id: ACCOUNT_HISTORY_DATATYPE,
    type: "patchwork:datatype",
    name: "Account History",
    icon: "Clock",
    unlisted: true,
    async load() {
      return {
        getTitle: (doc: HistoryDoc) => doc.title || "Account History",
        create: (): HistoryDoc => ({
          ["@patchwork"]: { type: ACCOUNT_HISTORY_DATATYPE },
          title: "Account History",
          entries: [],
        }),
      };
    },
  },
  {
    id: "account-history-toolbar",
    type: "patchwork:tool",
    tags: ["titlebar-tool"],
    name: "Account History",
    supportedDatatypes: ["account"],
    icon: "Clock",
    unlisted: true,
    async load(): Promise<ToolImplementation<any>> {
      const { renderHistoryRecorder } = await import("./HistoryRecorder.tsx");
      return renderHistoryRecorder;
    },
  },
  {
    id: VIEWER_TOOL_ID,
    type: "patchwork:tool",
    name: "Account History Viewer",
    supportedDatatypes: [ACCOUNT_HISTORY_DATATYPE],
    icon: "Clock",
    async load(): Promise<ToolImplementation<HistoryDoc>> {
      const { renderHistoryViewer } = await import("./HistoryViewer.tsx");
      return renderHistoryViewer;
    },
  },
  {
    id: NOTEBOOK_VIEWER_TOOL_ID,
    type: "patchwork:tool",
    name: "Account History Notebook",
    supportedDatatypes: [ACCOUNT_HISTORY_DATATYPE],
    icon: "BookOpen",
    async load(): Promise<ToolImplementation<HistoryDoc>> {
      const { renderNotebookViewer } = await import("./NotebookViewer.tsx");
      return renderNotebookViewer;
    },
  },
];
