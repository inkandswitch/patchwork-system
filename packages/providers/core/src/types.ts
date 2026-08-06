import type {
  AnyDocumentId,
  DocHandle,
  DocumentId,
  DocumentProgress,
} from "@automerge/automerge-repo";

/**
 * Minimal repo surface that both the real `Repo` and overlay repos (e.g.
 * `WorkspaceRepo`) can satisfy. Consumers requesting `patchwork:repo`
 * should type the result as `RepoLike` rather than `Repo` so the overlay
 * path stays honest.
 *
 * Tracks the methods that hook libraries reach for:
 * - `find` (used by `solid-automerge`)
 * - `findWithProgress` (used by `automerge-repo-react-hooks`'
 *   `useDocHandle` for the synchronous fast-path peek)
 * - `create` / `create2` (the latter awaits the deterministic id factory,
 *   used by `createDocOfDatatype2`)
 * - `handles` (synchronous documentId → handle index)
 */
export type RepoLike = {
  find<T>(id: AnyDocumentId): Promise<DocHandle<T>>;
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T>;
  create<T>(initialValue?: T): DocHandle<T>;
  create2<T>(initialValue?: T): Promise<DocHandle<T>>;
  readonly handles: Record<DocumentId, DocHandle<unknown>>;
};
