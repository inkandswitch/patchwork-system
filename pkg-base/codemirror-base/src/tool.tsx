import { CodeMirror } from "./lib/codemirror.tsx";
import { render } from "solid-js/web";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";

/** CodeMirror Extensions */
import { RangeSet, type Extension, type Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { commentUI } from "./lib/extensions/commentUI.ts";

/** Automerge */
import type { PatchworkToolProps } from "./types.ts";
import {
  cursor,
  type AutomergeUrl,
  DocHandle,
  Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

/** Patchwork */
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";

/** Styles */
import { createMemo, createResource, Show } from "solid-js";
import {
  createCommentForRange,
  type Comment,
  type CommentThread,
  type DocWithComments,
} from "./lib/extensions/comments.ts";

export type TextDoc = {
  content: string;
};

type CommentEntry = {
  targetUrl: AutomergeUrl;
  threadUrl: AutomergeUrl;
};

// Diff baseline served by the draft overlay (`draft:baseline`). `heads` is
// `null` when there is no baseline yet (e.g. the doc hasn't been COW'd in the
// active draft, or "main" is selected), in which case no diff is rendered.
type Baseline = { heads: UrlHeads | null };

const PATH = ["content"];

export function CodeMirrorEditor(props: PatchworkToolProps<TextDoc>) {
  // Diff baseline from the active draft overlay; plain JSON `{ heads }`. Fed to
  // the CodeMirror diff extension, which recomputes spans on every doc change
  // (driven by the sync plugin's transactions, so no manual tick is needed).
  const baseline = subscribe<Baseline>(
    props.element,
    { type: "draft:baseline", url: props.handle.url },
    { heads: null }
  );

  const commentEntries = subscribe<CommentEntry[]>(
    props.element,
    { type: "patchwork:comments" },
    []
  );

  const [focusDoc, focusHandle] = subscribeDoc<{
    selection: Record<AutomergeUrl, true>;
    highlight: Record<AutomergeUrl, true>;
  }>(props.element, { type: "patchwork:focus" });

  const contactUrl = subscribe<AutomergeUrl>(props.element, {
    type: "patchwork:contact",
  });

  const [commentTargets] = createResource(
    commentEntries,
    (entries) =>
      getDedupedCommentTargets(entries, props.handle.url, props.repo),
    { initialValue: [] }
  );

  // CommentsView writes selected comment targets into `selection`/`highlight`.
  // Read those URL keys directly so this memo updates when the maps change;
  // using `focusDoc()` itself doesn't trigger a change when the selection and highlight array inside of it change
  const focusRefUrls = createMemo(() => {
    const doc = focusDoc();
    return [
      ...Object.keys(doc?.selection ?? {}),
      ...Object.keys(doc?.highlight ?? {}),
    ] as AutomergeUrl[];
  });

  const [emphasisTargets] = createResource(
    focusRefUrls,
    async (urls) => resolveSubDocUrlsOfDoc(urls, props.handle.url, props.repo),
    { initialValue: [] }
  );

  // Bounding range of the focused targets (selection ∪ highlight). Recomputes
  // when the targets change -- e.g. selecting a comment thread elsewhere -- so
  // the editor can scroll the freshly focused region into view. Positions are
  // read imperatively; the resource re-emitting on focus change is the trigger.
  const scrollTarget = createMemo<readonly [number, number] | null>(() => {
    let from = Infinity;
    let to = -Infinity;
    for (const ref of emphasisTargets()) {
      const positions = ref.rangePositions();
      if (!positions) continue;
      const [start, end] = positions;
      from = Math.min(from, start);
      to = Math.max(to, end);
    }
    return from <= to ? [from, to] : null;
  });

  let lastEmittedUrl: AutomergeUrl | undefined;

  const onChangeSelection = (from: number, to: number) => {
    const handle = focusHandle();
    if (!handle) return;
    const nextUrl = props.handle.sub(...PATH, cursor(from, to)).url;
    if (nextUrl === lastEmittedUrl) return;
    handle.change((doc) => {
      doc.selection = { [nextUrl]: true };
    });
    lastEmittedUrl = nextUrl;
  };

  const decorations = () => {
    const targetRefs = commentTargets();
    const emphasisRefs = emphasisTargets();
    return RangeSet.of<Decoration>(
      buildCommentDecorations(targetRefs, emphasisRefs),
      true // sort ranges
    );
  };

  // Clicking the floating "Comment" button seeds an empty thread for the
  // selection and returns its url; the comment UI then opens that thread in a
  // popover for the author to fill in.
  const createThreadForRange = (
    from: number,
    to: number
  ): AutomergeUrl | null => {
    const url = contactUrl();
    if (!url) {
      console.warn("Cannot create comment: no contactUrl available");
      return null;
    }
    return createCommentForRange(props.handle, PATH, from, to, url);
  };

  // Find the thread whose commented range covers `pos` (and that range's
  // start), so clicking commented text can reopen the thread under its start.
  const threadAtPos = (
    pos: number
  ): { threadUrl: AutomergeUrl; from: number } | null => {
    const threadByTarget = new Map<AutomergeUrl, AutomergeUrl>();
    for (const entry of commentEntries()) {
      threadByTarget.set(entry.targetUrl, entry.threadUrl);
    }
    for (const handle of commentTargets()) {
      const positions = handle.rangePositions();
      if (!positions) continue;
      const [start, end] = positions;
      if (start === end || pos < start || pos > end) continue;
      const threadUrl = threadByTarget.get(handle.url as AutomergeUrl);
      if (threadUrl) return { threadUrl, from: start };
    }
    return null;
  };

  // Threads live inline under `@comments.threads` on this doc, so we resolve a
  // thread url back to its entry by matching the sub-handle url its id yields.
  const findThreadByUrl = (
    threadUrl: AutomergeUrl
  ): CommentThread | undefined => {
    const threads =
      (props.handle.doc() as DocWithComments | undefined)?.["@comments"]
        ?.threads ?? [];
    return threads.find(
      (thread) =>
        props.handle.sub("@comments", "threads", { id: thread.id }).url ===
        threadUrl
    );
  };

  // Watch a thread and fire `close` once the author's pending draft resolves —
  // i.e. the comment was submitted (or cancelled), or the thread went away.
  const watchThreadForClose = (
    threadUrl: AutomergeUrl,
    close: () => void
  ): (() => void) => {
    const contact = contactUrl();
    const hasOwnDraft = (thread: CommentThread): boolean =>
      thread.comments.some(
        (c) =>
          c.contactUrl === contact &&
          (c.draftContent !== undefined || c.content === undefined)
      );
    const seed = findThreadByUrl(threadUrl);
    let sawDraft = seed ? hasOwnDraft(seed) : false;
    const onChange = () => {
      const thread = findThreadByUrl(threadUrl);
      if (!thread) return close();
      if (hasOwnDraft(thread)) sawDraft = true;
      else if (sawDraft) close();
    };
    props.handle.on("change", onChange);
    return () => props.handle.off("change", onChange);
  };

  // When a popover closes, discard the author's own comment if it was never
  // filled in, and drop the thread if that leaves it empty — so dismissing a
  // just-opened "Comment" popover doesn't litter the doc with empty threads.
  const onClosePopover = (threadUrl: AutomergeUrl): void => {
    const contact = contactUrl();
    const isEmptyOwnDraft = (c: Comment): boolean =>
      c.contactUrl === contact &&
      c.content === undefined &&
      (c.draftContent === undefined || c.draftContent.trim() === "");
    const thread = findThreadByUrl(threadUrl);
    if (!thread || !thread.comments.some(isEmptyOwnDraft)) return;
    const threadId = thread.id;
    // Deferred so this write doesn't land inside the CodeMirror update that
    // tore the popover down (which is what triggers this callback).
    queueMicrotask(() => {
      props.handle.change((doc: DocWithComments) => {
        const list = doc["@comments"]?.threads;
        if (!list) return;
        const index = list.findIndex((t) => t.id === threadId);
        if (index === -1) return;
        const target = list[index];
        for (let i = target.comments.length - 1; i >= 0; i--) {
          if (isEmptyOwnDraft(target.comments[i])) target.comments.splice(i, 1);
        }
        if (target.comments.length === 0) list.splice(index, 1);
      });
    });
  };

  // The editor is only mounted once the datatype's extensions (themes, syntax
  // highlighting) are in hand, so it never paints unthemed first.
  const [datatypeExtensions] = createResource(() =>
    loadCodeMirrorExtensionsForDoc(props.handle)
  );

  // Base CodeMirror extensions (context-specific, not language-specific)
  const extensions = (): Extension[] => [
    commentUI({
      createThreadForRange,
      threadAtPos,
      watchThreadForClose,
      onClose: onClosePopover,
    }),
    ...(datatypeExtensions() ?? []),
  ];

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
        background: "var(--studio-fill, white)",
      }}
    >
      <div style={{ display: "flex", height: "100%" }}>
        <div style={{ position: "relative", flex: 1, height: "100%" }}>
          <Show when={datatypeExtensions.state === "ready"}>
            <CodeMirror
              handle={props.handle as DocHandle<TextDoc>}
              repo={props.repo}
              path={PATH}
              decorations={decorations}
              baseline={() => baseline()?.heads ?? null}
              extensions={extensions()}
              onChangeSelection={onChangeSelection}
              scrollTarget={scrollTarget}
              contactUrl={() => contactUrl() ?? null}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

// The tool implementation returned by the plugin's `load()`. Lives here (not in
// the `.ts` entrypoint) because it uses JSX and imports the Solid runtime.
export const mount: ToolImplementation<TextDoc> = (handle, element) =>
  render(
    () => (
      <CodeMirrorEditor handle={handle} repo={element.repo} element={element} />
    ),
    element
  );

// The comments provider already scopes entries to this doc by `targetUrl`,
// so this just dedupes and resolves each url to a `DocHandle`.
async function getDedupedCommentTargets(
  comments: CommentEntry[] | undefined,
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  if (!comments) return [];
  const overlappingRefs = new Set<DocHandle<unknown>>();
  for (const comment of comments) {
    if (comment.targetUrl.startsWith(docUrl)) {
      const target = await repo.find(comment.targetUrl);
      overlappingRefs.add(target);
    }
  }
  return Array.from(overlappingRefs);
}

// Scopes ref urls to this doc and resolves each one to a `DocHandle`.
// Used for both our own `selection` and other views' `highlight`.
async function resolveSubDocUrlsOfDoc(
  urls: AutomergeUrl[],
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  const refs = new Set<DocHandle<unknown>>();
  for (const url of urls) {
    if (url.startsWith(docUrl)) {
      refs.add(await repo.find(url));
    }
  }
  return Array.from(refs);
}

// Targets that overlap `emphasisRefs` (selection ∪ highlight) render in a
// stronger secondary tint of the editor surface; the rest stay in a faint one.
// Both keep the editor's own text legible (see `commentTargetStyle`).
function buildCommentDecorations(
  targetRefs: DocHandle<unknown>[],
  emphasisRefs: DocHandle<unknown>[]
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const ref of targetRefs) {
    const positions = ref.rangePositions();
    if (!positions) continue;
    const [start, end] = positions;
    if (start === end) continue;
    const isEmphasised = emphasisRefs.some((s) => s.overlaps(ref));
    out.push(
      Decoration.mark({
        attributes: { style: commentTargetStyle(isEmphasised) },
      }).range(start, end)
    );
  }
  return out;
}

function commentTargetStyle(isEmphasised: boolean): string {
  // Highlighter-over-paper: tint the editor surface (--text-editor-fill) with the
  // secondary accent and leave the text in the editor's own ink (we never set
  // `color`), so it stays readable on both light and dark themes.
  //   emphasised -> a stronger tint (the focused target)
  //   plain      -> a faint tint
  const paper = isEmphasised ? "56%" : "82%";
  return `
    border-bottom: 2px solid var(--text-editor-secondary-text);
    background-color: color-mix(in oklch, var(--studio-secondary), var(--text-editor-fill) ${paper});
  `;
}

async function loadCodeMirrorExtensionsForDoc(
  handle: DocHandle<unknown>
): Promise<Extension[]> {
  const docType = (handle.doc() as any)?.["@patchwork"]?.type;
  const registry = getRegistry<any>("codemirror:extension");
  const loaded = await registry.loadAll(
    registry.filter((ext) => {
      return (
        ext.supportedDatatypes === "*" ||
        (Array.isArray(ext.supportedDatatypes) &&
          ext.supportedDatatypes.includes(docType))
      );
    })
  );
  return loaded.flatMap((ext) => {
    const impl = ext.module;
    return Array.isArray(impl) ? impl : [impl];
  });
}
