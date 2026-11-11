import "./styles.css";
// Pulls in <patchwork-view> JSX intrinsic type augmentations.
import type {} from "@inkandswitch/patchwork-elements";
import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  onMount,
  Show,
  For,
} from "solid-js";

import { relativeTime } from "./relative-time";
import { useDocument } from "solid-automerge";
import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import { type ToolElement } from "@inkandswitch/patchwork-plugins";
import {
  createCuteEditor,
  defaultSchema,
  defaultAutocompletes,
} from "cute.txt";
import { CuteText } from "cute.txt/solid";
import { createReply, type Comment, type CommentThread } from "./comments";

// A standalone tool rendering a single comment thread from its subdocument
// handle. The host (`CommentsView`) owns the cross-thread orchestration
// (which thread is primary/secondary) and feeds that in through the
// `data-thread-state` attribute; everything else about a thread — its
// comments, draft editing, and the resolve/reply actions — lives here.
export function CommentThreadView(props: {
  handle: DocHandle<CommentThread>;
  element: ToolElement;
  repo: Repo;
}) {
  const [, contactHandle] = subscribeDoc<Record<string, never>>(props.element, {
    type: "patchwork:contact",
  });
  const currentContactUrl = () =>
    contactHandle()?.url as AutomergeUrl | undefined;

  const [thread, setThread] = createSignal<CommentThread | undefined>(
    props.handle.doc() as CommentThread | undefined
  );
  createEffect(() => {
    const h = props.handle;
    setThread(() => h.doc() as CommentThread | undefined);
    const onChange = () => setThread(() => h.doc() as CommentThread | undefined);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });

  // The host tags us with our current selection state; it alone can pick a
  // single primary among several overlapping threads (and honour the pin
  // tiebreaker), so we just reflect what it decided. `CommentsView` always
  // sets this attribute explicitly, so its absence means we're mounted
  // without a host orchestrating multiple threads (e.g. a thread opened on
  // its own as a standalone tool) — in which case we're inherently the only
  // (and therefore primary) thread.
  const state = createElementAttribute(
    props.element,
    "data-thread-state",
    "primary"
  );
  const isPrimary = () => state() === "primary";
  const stateClass = () =>
    state() === "primary"
      ? "comments-thread-card--primary"
      : state() === "secondary"
        ? "comments-thread-card--secondary"
        : "comments-thread-card--inactive";

  // A document-level thread targets the whole document: its ref is a bare
  // document url (no `/` path or `#` heads pointing at a range within it).
  const isDocLevel = createMemo(() => {
    const refs = thread()?.refs ?? [];
    return (
      refs.length > 0 &&
      refs.every((ref) => !ref.includes("/") && !ref.includes("#"))
    );
  });

  // The sidebar hides resolved threads, but an embedded thread renders
  // whatever it's pointed at — so it needs to show a resolved thread as such
  // (still readable) and offer a way to reopen it.
  const isResolved = () => thread()?.isResolved ?? false;

  const cardClass = () =>
    `comments-thread-card ${stateClass()}${
      isResolved() ? " comments-thread-card--resolved" : ""
    }`;

  // `thread().comments` is a fresh Automerge proxy every change; returning
  // the previous array when the id sequence is unchanged keeps <For> from
  // tearing down focused draft textareas on each keystroke.
  const commentIds = createMemo<string[]>((prev) => {
    const t = thread();
    if (!t) return [];
    const next: string[] = [];
    for (const c of t.comments) next.push(c.id);
    if (
      prev &&
      prev.length === next.length &&
      next.every((id, i) => id === prev[i])
    ) {
      return prev;
    }
    return next;
  }, []);

  // Multiple drafts can coexist in the same thread (e.g. two people replying
  // concurrently). The Save/Cancel actions below act on whichever comment
  // this returns, so it must prefer *our own* draft — otherwise it could
  // silently target someone else's unfinished comment instead of ours.
  const draftComment = createMemo(() => {
    const t = thread();
    if (!t) return undefined;
    const isDraft = (c: Comment) =>
      c.draftContent !== undefined || c.content === undefined;
    const contactUrl = currentContactUrl();
    return (
      t.comments.find((c) => isDraft(c) && c.contactUrl === contactUrl) ??
      t.comments.find(isDraft)
    );
  });

  const draftCommentHandle = createMemo(() => {
    const t = thread();
    const d = draftComment();
    if (!t || !d) return undefined;
    return props.handle.sub("comments", { id: d.id }) as DocHandle<Comment>;
  });

  const onResolveThread = () => {
    props.handle.change((t) => {
      t.isResolved = true;
    });
  };

  const onReopenThread = () => {
    props.handle.change((t) => {
      t.isResolved = false;
    });
  };

  const onReplyToComment = () => {
    const contactUrl = currentContactUrl();
    if (!contactUrl) return;
    createReply({ threadHandle: props.handle, content: "", contactUrl });
  };

  const onDeleteComment = (commentHandle: DocHandle<Comment>) => {
    commentHandle.remove();
    if (props.handle.doc()?.comments.length === 0) {
      props.handle.remove();
    }
  };

  const onSaveDraft = () => {
    const h = draftCommentHandle();
    if (!h) return;
    h.change((comment: Comment) => {
      comment.content = comment.draftContent;
      comment.timestamp = Date.now();
      delete comment.draftContent;
    });
  };

  const onCancelDraft = () => {
    const h = draftCommentHandle();
    if (!h) return;
    const commentValue = h.doc() as Comment | undefined;
    if (commentValue?.content === undefined) {
      onDeleteComment(h);
      return;
    }
    h.change((comment: Comment) => {
      delete comment.draftContent;
    });
  };

  return (
    <Show when={thread()}>
      <div class={cardClass()}>
        <div class="comments-thread-card-body">
          <Show when={isResolved()}>
            <span class="comments-thread-resolved-label">Resolved</span>
          </Show>
          <Show when={isDocLevel()}>
            <span class="comments-thread-doc-level">On this document</span>
          </Show>
          <For each={commentIds()}>
            {(commentId) => {
              const commentHandle = createMemo(
                () =>
                  props.handle.sub("comments", {
                    id: commentId,
                  }) as DocHandle<Comment>
              );
              return (
                <Show when={commentHandle()}>
                  {(handle) => (
                    <CommentView
                      commentHandle={handle()}
                      currentContactUrl={currentContactUrl()}
                      repo={props.repo}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </div>
      <Show when={draftComment() || isResolved() || isPrimary()}>
        <div class="comments-thread-actions">
          <Show
            when={draftComment()}
            fallback={
              <Show
                when={isResolved()}
                fallback={
                  <>
                    <button
                      class="comment-btn"
                      onClick={onResolveThread}
                      title="Resolve comment"
                    >
                      Resolve
                    </button>
                    <button
                      class="comment-btn"
                      onClick={onReplyToComment}
                      title="Reply to comment"
                    >
                      Reply
                    </button>
                  </>
                }
              >
                <button
                  class="comment-btn"
                  onClick={onReopenThread}
                  title="Reopen comment"
                >
                  Reopen
                </button>
              </Show>
            }
          >
            <button class="comment-btn" onClick={onCancelDraft}>
              Cancel
            </button>
            <button class="comment-btn" onClick={onSaveDraft}>
              Save
            </button>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

type ContactDoc = { type: "anonymous" } | { type: "registered"; name: string };

function CommentView(props: {
  commentHandle: DocHandle<Comment>;
  currentContactUrl?: string;
  repo: Repo;
}) {
  const [comment, setComment] = createSignal<Comment | undefined>(undefined);
  createEffect(() => {
    const h = props.commentHandle;
    setComment(() => h.doc() as Comment | undefined);
    const onChange = () => setComment(() => h.doc() as Comment | undefined);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });

  const contactUrl = () => comment()?.contactUrl as AutomergeUrl | undefined;
  const [contact] = useDocument<ContactDoc>(contactUrl, { repo: props.repo });

  const isDraft = () => {
    const c = comment();
    if (!c) return false;
    return c.draftContent !== undefined || c.content === undefined;
  };

  const shouldRender = () => {
    const c = comment();
    if (!c) return false;
    if (isDraft() && c.contactUrl !== props.currentContactUrl) return false;
    return true;
  };

  const contactName = () => {
    const ct = contact();
    return ct?.type === "registered" ? ct.name : "Anonymous";
  };

  return (
    <Show when={shouldRender() && comment()}>
      <div class="comment-card" data-id={props.commentHandle.url}>
        <div class="comment-header">
          <div class="comment-author">
            <patchwork-view
              doc-url={comment()!.contactUrl}
              tool-id="contact-avatar"
            />
            <span class="comment-author-name">{contactName()}</span>
          </div>
          <Show when={!isDraft() && comment()!.timestamp}>
            <span class="comment-timestamp">
              {relativeTime(comment()!.timestamp!)}
            </span>
          </Show>
        </div>
        <Show
          when={isDraft()}
          fallback={
            <div class="comment-content">
              <CuteText text={() => comment()?.content ?? ""} />
            </div>
          }
        >
          <CuteDraftEditor
            commentHandle={props.commentHandle}
            repo={props.repo}
          />
        </Show>
      </div>
    </Show>
  );
}

// A cute.txt editor bound to the comment's `draftContent`. The editor edits the
// field in place via `am.splice`, so it must already be a string; a fresh draft
// has no `draftContent` yet, so we seed it to "" before mounting.
function CuteDraftEditor(props: {
  commentHandle: DocHandle<Comment>;
  repo: Repo;
}) {
  let parent!: HTMLDivElement;
  onMount(() => {
    const handle = props.commentHandle;
    if (typeof handle.doc()?.draftContent !== "string") {
      handle.change((c: Comment) => {
        if (typeof c.draftContent !== "string") c.draftContent = "";
      });
    }
    const editor = createCuteEditor({
      handle,
      path: ["draftContent"],
      schema: defaultSchema,
      // `defaultAutocompletes` is a map keyed by id; the editor wants the specs
      // as a flat array (e.g. the built-in emoji `:` completer).
      autocompletes: Object.values(defaultAutocompletes),
      parent,
      repo: props.repo,
    });
    editor.view.focus();

    // Cmd/Ctrl+Space sends the draft — the same commit the Save button does
    // (`draftContent` → `content`). Capture-phase so it wins before CodeMirror
    // treats the Space as text input.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.code !== "Space") return;
      event.preventDefault();
      event.stopPropagation();
      const draft = handle.doc()?.draftContent ?? "";
      if (!draft.trim()) return;
      handle.change((c: Comment) => {
        c.content = c.draftContent;
        c.timestamp = Date.now();
        delete c.draftContent;
      });
    };
    parent.addEventListener("keydown", onKeyDown, true);

    onCleanup(() => {
      parent.removeEventListener("keydown", onKeyDown, true);
      editor.destroy();
    });
  });
  return <div class="cutetxt-editor comment-draft-editor" ref={parent} />;
}

// Reactively track a single attribute on `element`, seeded from its current
// value and updated via a `MutationObserver`. Used to receive the host's
// per-thread selection state as a `data-*` attribute. The host sets it on the
// `<patchwork-view>`, but the tool is handed the content element that view
// renders into, so it's read from the view.
function createElementAttribute(
  toolElement: HTMLElement,
  name: string,
  fallback: string
): () => string {
  const element = toolElement.closest("patchwork-view") ?? toolElement;
  const read = () => element.getAttribute(name) ?? fallback;
  const [value, setValue] = createSignal(read());
  onMount(() => {
    const observer = new MutationObserver(() => setValue(read()));
    observer.observe(element, { attributes: true, attributeFilter: [name] });
    setValue(read());
    onCleanup(() => observer.disconnect());
  });
  return value;
}
