import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { COMMENT_THREAD_TYPE, type CommentThread } from "./comments";

/** A short, single-line preview of a thread's first comment. */
const firstCommentSnippet = (doc: CommentThread): string | undefined => {
  const first = doc.comments?.find((c) => c.content);
  const text = first?.content?.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

export const CommentThreadDatatype: DatatypeImplementation<CommentThread> = {
  getTitle: (doc) => {
    if (doc["@patchwork"]?.title) return doc["@patchwork"].title;
    const snippet = firstCommentSnippet(doc);
    return snippet ? `Comment: ${snippet}` : "Comment thread";
  },
  setTitle(doc, title) {
    if (!doc["@patchwork"]) doc["@patchwork"] = { type: COMMENT_THREAD_TYPE };
    doc["@patchwork"].title = title;
  },
};
