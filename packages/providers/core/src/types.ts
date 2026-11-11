import type {
  AnyDocumentId,
  DocHandle,
  DocumentId,
  DocumentProgress,
  DocumentQuery,
} from "@automerge/automerge-repo/slim";

/**
 * The part of a `Repo` an `OverlayRepo` has too. Type a repo that may be an
 * overlay as `RepoLike`, not `Repo`. It's what hook libraries reach for:
 * `find` (solid-automerge), `query` (automerge-repo-react-hooks'
 * `useDocHandle`, for its synchronous `state()`), `create` (async, as in
 * automerge-repo 3), `findWithProgress` (deprecated, a progress-shaped view of
 * `query`) and `handles`.
 */
export type RepoLike = {
  find<T>(
    id: AnyDocumentId,
    options?: { signal?: AbortSignal }
  ): Promise<DocHandle<T>>;
  query<T>(id: AnyDocumentId): DocumentQuery<T>;
  /** @deprecated Use `query`. */
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T>;
  create<T>(initialValue?: T): Promise<DocHandle<T>>;
  readonly handles: Record<DocumentId, DocHandle<unknown>>;
};
