import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  ViewUpdate,
  dropCursor,
  type DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import {
  type AutomergeUrl,
  type DocumentId,
  isValidDocumentId,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { embedTheme } from "../themes/embed.ts";

/**
 * Renders an embedded doc through the shared "embed" tool, which draws the
 * chrome and nests the content view. The inner tool travels via the
 * `embed-tool-id` attribute; tool picks come back as
 * `patchwork:embed-tool-changed` events and are persisted by rewriting the
 * marker (which recreates the widget).
 */
class EmbedWidget extends WidgetType {
  readonly docId: DocumentId;
  // `null` = no pinned tool; the embed frame uses the datatype's fallback.
  readonly toolId: string | null;
  readonly embedText: string;

  constructor(docId: DocumentId, toolId: string | null, embedText: string) {
    super();
    this.docId = docId;
    this.toolId = toolId;
    this.embedText = embedText;
  }

  eq(other: EmbedWidget) {
    return other.docId === this.docId && other.toolId === this.toolId;
  }

  toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-embed";

    const patchworkView = document.createElement("patchwork-view");
    // No heads in the url: the embed follows whatever version the host
    // resolves — the active checkpoint when one is checked out, live otherwise.
    patchworkView.setAttribute("doc-url", `automerge:${this.docId}`);
    patchworkView.setAttribute("tool-id", "embed");
    if (this.toolId) patchworkView.setAttribute("embed-tool-id", this.toolId);
    // Explicit inline height: without it the element collapses to 0px (the
    // stylesheet rule isn't reliably applied here).
    patchworkView.style.display = "block";
    patchworkView.style.height = "500px";
    patchworkView.style.width = "100%";

    // Persist tool picks into the marker text. Stop propagation so nested
    // embeds don't also change the outer embed's tool.
    container.addEventListener("patchwork:embed-tool-changed", (e) => {
      e.stopPropagation();
      const toolId = (e as CustomEvent<{ toolId?: string }>).detail?.toolId;
      if (toolId) this.setTool(view, container, toolId);
    });

    container.appendChild(patchworkView);
    return container;
  }

  private setTool(
    view: EditorView,
    container: HTMLElement,
    toolId: string
  ): void {
    const from = view.posAtDOM(container);
    const to = from + this.embedText.length;
    // Only rewrite if the marker is still exactly where this widget maps to.
    if (view.state.doc.sliceString(from, to) !== this.embedText) return;
    view.dispatch({
      changes: { from, to, insert: embedSyntax({ docId: this.docId, toolId }) },
    });
  }

  ignoreEvent() {
    // Atomic embed: the editor ignores all events; the frame handles them.
    return true;
  }
}

// Marker syntax: [patchwork:docId] or [patchwork:docId/toolId] (ids can't
// contain `/` or `]`). We scan plain text instead of the markdown syntax tree
// on purpose: `@codemirror/language` isn't a shared singleton across
// patchwork's separately-bundled extensions, so `syntaxTree(state)` here would
// read a different `Language` facet and always come back empty.
const EMBED_PATTERN = /\[patchwork:([^/\]]+)(?:\/([^\]]+))?\]/g;

function getEmbedLinks(view: EditorView) {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;

  // Visible ranges are line-aligned and markers never span lines, so a marker
  // is always fully inside or fully outside a range.
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    EMBED_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMBED_PATTERN.exec(text)) !== null) {
      const matchFrom = from + m.index;
      const matchTo = matchFrom + m[0].length;
      const [matchText, docId, toolId] = m;

      if (!isValidDocumentId(docId)) continue;

      const embed = Decoration.replace({
        widget: new EmbedWidget(docId as DocumentId, toolId ?? null, matchText),
      });
      widgets.push(embed.range(matchFrom, matchTo));
    }
  }

  // `true` lets CodeMirror sort the ranges defensively (matches are already in
  // document order, but this is cheap insurance).
  return Decoration.set(widgets, true);
}

// MIME types we accept document drags from. Mirrors the sideboard's convention.
const PATCHWORK_DND = "text/x-patchwork-dnd";
const PATCHWORK_URLS = "text/x-patchwork-urls";

type DocRef = { docId: DocumentId; toolId: string | null };

/** Turn an automerge url or a patchwork web link into a DocumentId, or null. */
function urlToDocId(raw: string): DocumentId | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Plain automerge url (optionally carrying heads/query/subpath).
  const am = trimmed.match(/automerge:([a-zA-Z0-9]+)/);
  if (am && isValidDocumentId(am[1])) return am[1] as DocumentId;
  // Patchwork web link: #doc=<documentId> (also &doc= / ?doc=).
  const web = trimmed.match(/[#&?]doc=([a-zA-Z0-9]+)/);
  if (web && isValidDocumentId(web[1])) return web[1] as DocumentId;
  return null;
}

/**
 * Read dragged documents out of a drop event, in order of format preference.
 * Only an *explicit* `toolId` on a structured item pins the tool; otherwise we
 * embed tool-less and let the view fall back to the datatype's default tool.
 */
function extractDocRefs(dt: DataTransfer): DocRef[] {
  const refs: DocRef[] = [];
  const seen = new Set<string>();
  const push = (docId: DocumentId | null, toolId: string | null) => {
    if (!docId || seen.has(docId)) return;
    seen.add(docId);
    refs.push({ docId, toolId });
  };

  const dnd = dt.getData(PATCHWORK_DND);
  if (dnd) {
    try {
      const parsed = JSON.parse(dnd) as {
        items?: Array<{ url?: string; toolId?: string }>;
      };
      for (const item of parsed?.items ?? []) {
        if (item?.url) push(urlToDocId(item.url), item.toolId ?? null);
      }
    } catch {
      // fall through to the other formats
    }
  }
  if (refs.length > 0) return refs;

  const urls = dt.getData(PATCHWORK_URLS);
  if (urls) {
    try {
      const parsed: unknown = JSON.parse(urls);
      if (Array.isArray(parsed)) {
        for (const u of parsed) push(urlToDocId(String(u)), null);
      }
    } catch {
      // fall through
    }
  }
  if (refs.length > 0) return refs;

  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) continue; // uri-list comments
      push(urlToDocId(line), null);
    }
  }
  return refs;
}

function embedSyntax({ docId, toolId }: DocRef): string {
  return toolId ? `[patchwork:${docId}/${toolId}]` : `[patchwork:${docId}]`;
}

/**
 * Import each OS file dropped from the desktop as a Patchwork `file` document,
 * returning tool-less refs to embed. Uses the realm-local `window.repo` (the
 * documented global) — fine for creating brand-new docs, which aren't subject
 * to draft remapping.
 */
async function fileDropRefs(files: FileList): Promise<DocRef[]> {
  const repo = (window as unknown as { repo?: any }).repo;
  if (!repo) {
    console.warn(
      "[codemirror-embed] window.repo unavailable; ignoring dropped files"
    );
    return [];
  }
  const refs: DocRef[] = [];
  for (const file of Array.from(files)) {
    try {
      const mimeType = file.type || "application/octet-stream";
      const isText =
        mimeType.startsWith("text/") || mimeType === "application/json";
      const content = isText
        ? await file.text()
        : new Uint8Array(await file.arrayBuffer());
      const parts = file.name.split(".");
      const extension = parts.length > 1 ? parts.pop()! : "";
      const handle = repo.create();
      handle.change((d: any) => {
        d["@patchwork"] = { type: "file" };
        d.content = content;
        d.mimeType = mimeType;
        d.extension = extension;
        d.name = file.name;
      });
      const { documentId } = parseAutomergeUrl(handle.url as AutomergeUrl);
      if (isValidDocumentId(documentId)) {
        refs.push({ docId: documentId as DocumentId, toolId: null });
      }
    } catch (err) {
      console.warn(
        "[codemirror-embed] failed to import dropped file",
        file.name,
        err
      );
    }
  }
  return refs;
}

function insertRefs(view: EditorView, pos: number, refs: DocRef[]): void {
  if (refs.length === 0) return;
  let text = refs.map(embedSyntax).join("\n\n");
  // On a non-empty line, add just enough breaks to put the embed on its own line.
  const line = view.state.doc.lineAt(pos);
  if (/\S/.test(line.text)) {
    if (pos > line.from) text = "\n" + text;
    if (pos < line.to) text = text + "\n";
  }
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/**
 * Drop handler that accepts:
 *  - documents dragged from the sidebar / canvases / other tools
 *    (`text/x-patchwork-dnd`, `text/x-patchwork-urls`, `text/uri-list`, and
 *    `text/plain` patchwork links), and
 *  - files dragged in from the operating system (imported as `file` docs).
 * Inserts `[patchwork:docId]` (or `[patchwork:docId/toolId]`) at the drop point.
 */
function embedDropHandlers() {
  // Only claim the *dragover* for unambiguous patchwork/OS drags — plain
  // text/uri-list can be an ordinary in-editor text drag, which we must not
  // swallow. (`Files` covers OS drags, whose `dt.files` is empty until drop.)
  const wantsDragover = (dt: DataTransfer | null): boolean =>
    !!dt &&
    (dt.types.includes("Files") ||
      dt.types.includes(PATCHWORK_DND) ||
      dt.types.includes(PATCHWORK_URLS));

  return EditorView.domEventHandlers({
    dragover(event) {
      const dt = event.dataTransfer;
      if (!wantsDragover(dt)) return false;
      event.preventDefault();
      // Doc drags insert a *reference* to the same automerge doc, so show the
      // link cursor; OS file drags genuinely copy content into new docs.
      if (dt) dt.dropEffect = dt.types.includes("Files") ? "copy" : "link";
      return true;
    },
    drop(event, view) {
      const dt = event.dataTransfer;
      if (!dt) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;

      // OS files import asynchronously; insert once the docs exist.
      if (dt.files && dt.files.length > 0) {
        event.preventDefault();
        void fileDropRefs(dt.files).then((refs) => insertRefs(view, pos, refs));
        return true;
      }

      // Otherwise only handle the drop if it actually resolves to patchwork
      // docs (dnd/urls always do; uri-list/plain only for patchwork links).
      // If not, let CodeMirror handle it as a normal text drop.
      const refs = extractDocRefs(dt);
      if (refs.length === 0) return false;
      event.preventDefault();
      insertRefs(view, pos, refs);
      return true;
    },
  });
}

const embedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = getEmbedLinks(view);
    }

    update(update: ViewUpdate) {
      // Viewport too, so newly-visible markers get decorated.
      if (update.docChanged || update.viewportChanged) {
        this.decorations = getEmbedLinks(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Atomic: the cursor skips embeds and delete removes the whole marker.
    provide: (plugin) =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.decorations ?? Decoration.none
      ),
  }
);

export function markdownEmbed() {
  // `dropCursor` observes events, so it coexists with our dragover handler.
  return [embedPlugin, embedTheme, embedDropHandlers(), dropCursor()];
}
