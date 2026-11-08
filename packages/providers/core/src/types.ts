import type {
  AnyDocumentId,
  DocHandle,
  DocumentId,
  DocumentProgress,
} from "@automerge/automerge-repo/slim";

/**
 * The part of a `Repo` an `OverlayRepo` has too. Type a repo that may be an
 * overlay as `RepoLike`, not `Repo`. It's what hook libraries reach for:
 * `find` (solid-automerge), `findWithProgress` (automerge-repo-react-hooks'
 * `useDocHandle`, for its synchronous peek), `create` and `create2` (which
 * waits for the id factory; `createDocOfDatatype2` uses it), and `handles`.
 */
export type RepoLike = {
  find<T>(id: AnyDocumentId): Promise<DocHandle<T>>;
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T>;
  create<T>(initialValue?: T): DocHandle<T>;
  create2<T>(initialValue?: T): Promise<DocHandle<T>>;
  readonly handles: Record<DocumentId, DocHandle<unknown>>;
};
