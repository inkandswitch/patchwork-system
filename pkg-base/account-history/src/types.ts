import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  repo: Repo;
  element: PatchworkViewElement;
}

export type HistoryDoc = {
  "@patchwork": { type: "patchwork:account-history" };
  title: string;
  entries: HistoryEntry[];
};

export type HistoryEntry = {
  timestamp: number; // when opened (milliseconds since epoch)
  docUrl: AutomergeUrl; // document URL
  docTitle: string; // title at open time
  docType: string; // document type
  toolId: string; // tool used
  heads: string[]; // automerge heads at open time
};

