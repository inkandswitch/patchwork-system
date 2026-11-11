import { render } from "solid-js/web";
import { RepoContext } from "solid-automerge";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { STYLE as CUTE_STYLE } from "cute.txt/style";
import { CommentsView } from "./CommentsView";
import { CommentThreadView } from "./CommentThread";
import type { CommentThread } from "./comments";

// cute.txt is bundleless (no CSS import) and ships its styles as a string; the
// editor/rendered marks need them. Inject once into the document head — guarded
// so the two tools in this package (which both pull in this module) don't
// double it.
function ensureCuteStyle() {
  const id = "cute-txt-style";
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = CUTE_STYLE;
  document.head.append(style);
}
ensureCuteStyle();

export const renderCommentsView: ToolImplementation = (_handle, element) => {
  return render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <CommentsView element={element} />
      </RepoContext.Provider>
    ),
    element
  );
};

// Renders a single comment thread from its subdocument handle. Mounted by
// `CommentsView` via `<patchwork-view tool-id="comment-thread">`, one per
// thread, with the thread's subdocument url as `doc-url`.
export const renderCommentThread: ToolImplementation<CommentThread> = (
  handle,
  element
) => {
  return render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <CommentThreadView
          handle={handle}
          element={element}
          repo={element.repo}
        />
      </RepoContext.Provider>
    ),
    element
  );
};
