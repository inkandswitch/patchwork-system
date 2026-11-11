import * as A from "@automerge/automerge"

export type DocHandleChangePayload = {
  /**
   * The handle was re-pointed at a different backing document in place (for
   * example pinned to historical heads, or swapped to a clone), so heads
   * observed before this event may not exist in the new backing's history.
   * Consumers must reconcile from `doc()` rather than diff incrementally.
   * Handles whose backing never changes simply never set this.
   */
  scopeReplaced?: boolean
  /**
   * The document after the change. Always sent by automerge-repo handles;
   * the plugin reads the doc from `handle.doc()` instead, so it is typed
   * `unknown` here.
   */
  doc: unknown
}

export interface DocHandle<T> {
  isReady: () => boolean
  /**
   * True when the handle rejects writes, for example because it is pinned to
   * historical heads. Absent means always writable. Like `scopeReplaced`,
   * this can flip in place when the handle's backing is swapped.
   */
  isReadOnly?: () => boolean
  doc(): A.Doc<T>
  change(callback: (doc: A.Doc<T>) => void): void
  on(
    event: "change",
    callback: (payload?: DocHandleChangePayload) => void
  ): void
  off(
    event: "change",
    callback: (payload?: DocHandleChangePayload) => void
  ): void
}
