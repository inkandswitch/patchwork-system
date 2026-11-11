import {
  cursor,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo/slim";

export type DocWithComments = {
  "@comments"?: {
    threads: CommentThread[];
  };
};

/**
 * The `@patchwork.type` stamped on a comment thread so a datatype (and thus a
 * relevant tool) can be resolved when the thread's subdocument is opened on its
 * own. Mirrors `COMMENT_THREAD_TYPE` in the comments-view module.
 */
export const COMMENT_THREAD_TYPE = "comment-thread";

export type CommentThread = {
  id: string;
  refs: AutomergeUrl[];
  isResolved: boolean;
  comments: Comment[];
  "@patchwork"?: { type: string; title?: string };
};

export type Comment = {
  id: string;
  content?: string;
  draftContent?: string;
  contactUrl: AutomergeUrl;
  timestamp: number;
};

// Creates a thread (with one empty, unfilled comment) targeting [from, to] and
// returns the thread's url so the caller can open it — e.g. in a popover — for
// the author to fill in. An abandoned, never-filled comment should be cleaned
// up by the caller (see the comment UI's `onClose`).
export function createCommentForRange(
  handle: DocHandle<unknown>,
  path: readonly string[],
  from: number,
  to: number,
  contactUrl: AutomergeUrl
): AutomergeUrl {
  const targetUrl = handle.sub(...path, cursor(from, to)).url;
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();

  handle.change((doc: DocWithComments) => {
    doc["@comments"] ??= { threads: [] };
    doc["@comments"].threads.push({
      id: threadId,
      refs: [targetUrl],
      isResolved: false,
      comments: [
        {
          id: commentId,
          contactUrl,
          timestamp: Date.now(),
        },
      ],
      "@patchwork": { type: COMMENT_THREAD_TYPE },
    });
  });

  return handle.sub("@comments", "threads", { id: threadId }).url;
}
