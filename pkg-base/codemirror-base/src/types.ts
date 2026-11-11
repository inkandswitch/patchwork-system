import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  repo: Repo;
  element: HTMLElement;
}
