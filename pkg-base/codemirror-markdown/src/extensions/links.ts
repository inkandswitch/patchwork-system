import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isValidAutomergeUrl } from "@automerge/automerge-repo/slim";
import { linkTheme } from "../themes/links.ts";

/**
 * Widget to render a clickable link in the editor
 */
class LinkWidget extends WidgetType {
  readonly url: string;
  readonly text: string;

  constructor(url: string, text: string) {
    super();
    this.url = url;
    this.text = text;
  }

  eq(other: LinkWidget) {
    return other.url === this.url && other.text === this.text;
  }

  toDOM() {
    const link = document.createElement("a");
    link.href = this.url;
    link.textContent = this.text;
    link.className = "cm-link";
    link.title = this.url;

    link.onclick = (e) => {
      e.preventDefault();
      if (isValidAutomergeUrl(this.url)) {
        // Open the document inside Patchwork rather than as a browser URL
        // (automerge: isn't navigable). bubbles/composed so the event escapes
        // the editor and any shadow root up to whoever drives selection.
        link.dispatchEvent(
          new CustomEvent("patchwork:open-document", {
            detail: { url: this.url },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        window.open(this.url, "_blank noopener noreferrer");
      }
    };

    return link;
  }

  ignoreEvent(e: Event) {
    // Let click events through to our widget
    return e.type !== "click";
  }
}

function getLinks(view: EditorView) {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;
  const selection = state.selection.main;

  for (let { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        // Match markdown link syntax
        if (node.name === "Link") {
          const linkFrom = node.from;
          const linkTo = node.to;

          // Check if cursor is inside this link
          const cursorInLink =
            selection.from >= linkFrom && selection.from <= linkTo;
          // Check if the link is inside the selection
          const selectionSpansLink =
            selection.from < linkFrom && selection.to > linkTo;

          // Replace if cursor is outside the link and there's no selection across the link
          if (!cursorInLink && !selectionSpansLink) {
            const linkText = state.doc.sliceString(linkFrom, linkTo);
            const match = linkText.match(/\[([^\]]+)\]\(([^)]+)\)/);

            if (match) {
              const [, text, url] = match;

              // Replace the entire [text](url) with just the link widget
              const deco = Decoration.replace({
                widget: new LinkWidget(url, text),
              });

              widgets.push(deco.range(linkFrom, linkTo));
            }
          }
        }
      },
    });
  }

  return Decoration.set(widgets);
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = getLinks(view);
    }

    update(update: ViewUpdate) {
      // Recompute when doc changes, selection moves, or viewport changes
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = getLinks(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export function markdownLinks() {
  return [linkPlugin, linkTheme];
}
