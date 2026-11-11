import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";

/**
 * The `@patchwork.type` stamped on a comment thread so a datatype (and thus a
 * relevant tool, e.g. `comment-thread`) can be resolved when the thread's
 * subdocument is opened on its own — for instance in a tiling-frame panel.
 */
export const COMMENT_THREAD_TYPE = "comment-thread";

export type DocWithComments = {
  "@comments"?: {
    threads: CommentThread[];
  };
};

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
  // When present, the comment's `content` is treated as a reference (an
  // automerge url) to another document, and the comment renders that document
  // inline via `<patchwork-view>` instead of showing `content` as text. The
  // `type` picks the default tool/view; the user can switch to another.
  "@patchwork"?: { type: string; title?: string };
};

/**
 * Create a document-level comment thread: one that targets the whole
 * document (its only ref is the document's own url) rather than a range or
 * sub-doc within it. Used when the active tool or datatype can't locate
 * comments to a specific spot. Returns a handle to the seeded draft comment.
 */
export function createDocumentThread({
  docHandle,
  contactUrl,
  content,
}: {
  docHandle: DocHandle<DocWithComments>;
  contactUrl: AutomergeUrl;
  content?: string;
}): DocHandle<Comment> {
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();

  docHandle.change((doc) => {
    doc["@comments"] ??= { threads: [] };
    const comment: Comment = {
      id: commentId,
      contactUrl,
      timestamp: Date.now(),
    };
    if (content) comment.content = content;
    doc["@comments"].threads.push({
      id: threadId,
      refs: [docHandle.url],
      isResolved: false,
      comments: [comment],
      "@patchwork": { type: COMMENT_THREAD_TYPE },
    });
  });

  return docHandle.sub("@comments", "threads", {
    id: threadId,
  }).sub("comments", { id: commentId }) as DocHandle<Comment>;
}

export function createReply({
  threadHandle: thread,
  content,
  contactUrl,
}: {
  threadHandle: DocHandle<CommentThread>;
  content?: string;
  contactUrl: AutomergeUrl;
}): DocHandle<Comment> {
  const commentId = crypto.randomUUID();

  thread.change((thread) => {
    const comment: Comment = {
      id: commentId,
      contactUrl,
      timestamp: Date.now(),
    };

    if (content) comment.content = content;
    thread.comments.push(comment);
  });

  return thread.sub("comments", { id: commentId }) as DocHandle<Comment>;
}
