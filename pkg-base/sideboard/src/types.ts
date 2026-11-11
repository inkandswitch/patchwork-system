import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  repo: Repo;
  element: PatchworkViewElement;
}

/** The account-doc fields the account bar / combined sideboard read. */
export type SideboardAccountDoc = {
  rootFolderUrl?: AutomergeUrl;
  contactUrl?: AutomergeUrl;
  moduleSettingsUrl?: AutomergeUrl;
};
