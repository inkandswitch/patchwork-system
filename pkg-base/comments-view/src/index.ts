import { Plugin, ToolElement } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // A `patchwork:component` that takes no document: the render function
  // ignores its handle (it reads everything off `element`), so we pass `null`
  // and it can be slotted in without an account doc.
  {
    type: "patchwork:component",
    id: "comments-view",
    tags: ["context-tool"],
    name: "Comments",
    async load() {
      const { renderCommentsView } = await import("./main");
      return (element: ToolElement) => renderCommentsView(null as never, element);
    },
  },
  // The datatype for a comment thread subdocument. Registering it lets a
  // thread opened on its own (its `@patchwork.type` is `comment-thread`)
  // resolve a title and, via `supportedDatatypes` below, a tool.
  {
    type: "patchwork:datatype",
    id: "comment-thread",
    name: "Comment Thread",
    icon: "MessageSquare",
    unlisted: true,
    async load() {
      const { CommentThreadDatatype } = await import("./datatype");
      return CommentThreadDatatype;
    },
  },
  // Renders one comment thread from its subdocument url. Mounted explicitly
  // by `CommentsView` via `<patchwork-view>`, and also the tool for a thread
  // subdocument opened on its own.
  {
    type: "patchwork:tool",
    id: "comment-thread",
    name: "Comment Thread",
    supportedDatatypes: ["comment-thread"],
    async load() {
      const { renderCommentThread } = await import("./main");
      return renderCommentThread;
    },
  },
];
