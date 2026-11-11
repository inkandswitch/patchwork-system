import { Plugin } from "@inkandswitch/patchwork-plugins";
import { HistoryGroupingsDoc } from "./types";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:datatype",
    id: "patchwork:history-change-groups",
    name: "Document History Change Groups",
    icon: "History",
    unlisted: true,
    async load() {
      return {
        init: (doc: HistoryGroupingsDoc) => {
          if (!doc.sourceDocumentUrl) return;
          Object.assign(doc, {
            ["@patchwork"]: { type: "patchwork:history-change-groups" },
            version: doc.version || 1,
            sourceDocumentUrl: doc.sourceDocumentUrl,
            updatedAt: doc.updatedAt || 0,
            throttleMs: doc.throttleMs || 30 * 60 * 1000,
            heads: doc.heads || [],
            groupings: doc.groupings || {},
          } as HistoryGroupingsDoc);
        },
        getTitle: (doc: HistoryGroupingsDoc) => {
          return `History Change Groups for ${doc.sourceDocumentUrl}`;
        },
      };
    },
  },
  // A `patchwork:component` that takes no document: the view reads everything
  // off `element`, so it can be slotted in without an account doc.
  {
    type: "patchwork:component",
    id: "history-view",
    tags: ["context-tool"],
    name: "History",
    icon: "History",
    async load() {
      const { renderHistoryTimeline } = await import("./history/HistoryTimeline");
      return renderHistoryTimeline;
    },
  },
];
