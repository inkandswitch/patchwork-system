import { createEffect } from "solid-js";

/** CodeMirror */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSet, StateEffect, type Range } from "@codemirror/state";

/** Automerge */
import { next as Automerge } from "@automerge/automerge/slim";
import type { Prop as AutomergeProp } from "@automerge/automerge/slim";
import {
  decodeHeads,
  type Doc,
  type DocHandle,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

// Carries the diff baseline (fork-point heads) from the provider subscription
// into the editor. Dispatched only when the baseline changes (i.e. on fork),
// which is rare -- per-edit recomputation is driven by `docChanged`, not this.
const setBaseline = StateEffect.define<UrlHeads | null>();

/**
 * CodeMirror extension that renders a diff of the synced `path` against the
 * `baseline` heads. It recomputes its decorations on every doc change -- the
 * automerge sync plugin reflects both local and remote changes as editor
 * transactions -- so no external "tick" is needed. The baseline is pushed in
 * via a Solid effect because the editor can't observe a fork on its own.
 *
 * @returns the extension and an effect factory that feeds baseline changes in.
 */
export function createDiffExtension(
  handle: () => DocHandle<unknown>,
  path: () => AutomergeProp[],
  baseline: () => UrlHeads | null
) {
  const plugin = ViewPlugin.fromClass(
    class {
      baseline: UrlHeads | null = null;
      decorations: DecorationSet = Decoration.none;

      update(update: ViewUpdate) {
        let baselineChanged = false;
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(setBaseline)) {
              this.baseline = effect.value;
              baselineChanged = true;
            }
          }
        }
        if (update.docChanged || baselineChanged) {
          this.decorations = this.build();
        }
      }

      build(): DecorationSet {
        const heads = this.baseline;
        const doc = handle()?.doc();
        if (!heads || !doc) return Decoration.none;
        return RangeSet.of(
          buildDiffDecorations(
            diffContent(doc, heads, path()),
            prefersDarkMode()
          ),
          true // sort ranges
        );
      }
    },
    { decorations: (v) => v.decorations }
  );

  const createReconfigureEffect = (view: EditorView) =>
    createEffect(() => {
      view.dispatch({ effects: setBaseline.of(baseline()) });
    });

  return [plugin, createReconfigureEffect] as const;
}

type ContentDiff =
  | { type: "added"; from: number; to: number }
  | { type: "deleted"; at: number; text: string };

// Diff the text at `path` between the baseline heads and the live doc using
// Automerge patches directly (no annotations layer). A string field only ever
// produces `splice` (insert) and `del` (delete) patches on `[...path, idx]`,
// and their positions are in live-doc coordinates -- so `added` ranges map
// straight to CodeMirror offsets. For `del` the removed text isn't in the
// patch, so we recover it from the baseline view, tracking a running offset to
// convert the live position back to a baseline position.
function diffContent(
  doc: Doc<unknown>,
  baselineHeads: UrlHeads,
  path: AutomergeProp[]
): ContentDiff[] {
  const before = decodeHeads(baselineHeads);
  const beforeContent = lookupString(Automerge.view(doc, before), path);
  const patches = Automerge.diff(doc, before, Automerge.getHeads(doc));

  const out: ContentDiff[] = [];
  let offset = 0;
  for (const patch of patches) {
    if (!isIndexedChildOf(patch.path, path)) continue;
    const pos = patch.path[path.length] as number;
    if (patch.action === "splice") {
      const len = (patch.value as string).length;
      out.push({ type: "added", from: pos, to: pos + len });
      offset -= len;
    } else if (patch.action === "del") {
      const len = patch.length ?? 1;
      const original = pos + offset;
      out.push({
        type: "deleted",
        at: pos,
        text: beforeContent.substring(original, original + len),
      });
      offset += len;
    }
  }
  return out;
}

function buildDiffDecorations(
  diffs: ContentDiff[],
  dark: boolean
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const diff of diffs) {
    if (diff.type === "deleted") {
      out.push(
        Decoration.widget({
          widget: new DeletionMarker(diff.text, false),
          side: 1,
        }).range(diff.at)
      );
      continue;
    }
    // Skip zero-length added ranges.
    if (diff.from === diff.to) continue;
    out.push(
      Decoration.mark({
        attributes: { style: addedDiffStyle(dark) },
      }).range(diff.from, diff.to)
    );
  }
  return out;
}

// True when `patchPath` addresses a direct indexed child of `path`, e.g.
// `["content", 5]` is an indexed child of `["content"]`.
function isIndexedChildOf(
  patchPath: readonly AutomergeProp[],
  path: AutomergeProp[]
): boolean {
  if (patchPath.length !== path.length + 1) return false;
  for (let i = 0; i < path.length; i++) {
    if (patchPath[i] !== path[i]) return false;
  }
  return typeof patchPath[path.length] === "number";
}

function lookupString(doc: unknown, path: AutomergeProp[]): string {
  let current: unknown = doc;
  for (const key of path) {
    if (current == null) return "";
    current = (current as Record<AutomergeProp, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

function addedDiffStyle(dark: boolean): string {
  return `
    border-bottom: 2px solid ${dark ? "#4ade80" : "#22c55e"};
    background-color: ${dark ? "#14532d" : "#dcfce7"};
  `;
}

function prefersDarkMode(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

class DeletionMarker extends WidgetType {
  deletedText: string;
  isActive: boolean;

  constructor(deletedText: string, isActive: boolean) {
    super();
    this.deletedText = deletedText;
    this.isActive = isActive;
  }

  toDOM(): HTMLElement {
    const box = document.createElement("div");
    // Pin the badge to its own metrics so a tall line-height (e.g. on heading
    // lines) can't stretch it into a vertical rectangle. `position: relative`
    // anchors the hover tooltip to the badge so it can left-align to it.
    box.style.display = "inline-block";
    box.style.position = "relative";
    box.style.lineHeight = "1";
    box.style.verticalAlign = "middle";
    box.style.boxSizing = "border-box";
    box.style.padding = "2px 3px";
    box.style.color = "rgb(239 68 68)"; // red-500
    box.style.margin = "0 4px";
    box.style.fontSize = "1.2em";
    box.style.whiteSpace = "nowrap";
    box.style.backgroundColor = this.isActive
      ? "rgb(239 68 68 / 20%)" // red-500 with opacity
      : "rgb(239 68 68 / 10%)";
    box.style.borderRadius = "3px";
    box.style.cursor = "var(--studio-cursor-default, default)";
    box.innerText = "\u232b";

    const hoverText = document.createElement("div");
    hoverText.style.position = "absolute";
    hoverText.style.top = "100%";
    hoverText.style.left = "0";
    hoverText.style.zIndex = "1";
    hoverText.style.padding = "5px";
    hoverText.style.backgroundColor = "rgb(254 242 242)"; // red-50
    hoverText.style.fontSize = "15px";
    hoverText.style.color = "rgb(17 24 39)"; // gray-900
    hoverText.style.border = "var(--studio-border-width, 1px) var(--studio-border-style, solid) rgb(185 28 28)"; // red-700
    hoverText.style.boxShadow = "0px 0px 6px rgba(0, 0, 0, 0.1)";
    hoverText.style.borderRadius = "3px";
    hoverText.style.visibility = "hidden";
    hoverText.innerText = this.deletedText;

    const isDarkMode =
      document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;

    if (isDarkMode) {
      box.style.color = "rgb(248 113 113)"; // red-400 for dark mode
      box.style.backgroundColor = this.isActive
        ? "rgb(248 113 113 / 20%)"
        : "rgb(248 113 113 / 10%)";
      hoverText.style.backgroundColor = "rgb(69 10 10)"; // red-950
      hoverText.style.color = "rgb(254 226 226)"; // red-100
      hoverText.style.border = "var(--studio-border-width, 1px) var(--studio-border-style, solid) rgb(153 27 27)"; // red-800
    }

    box.appendChild(hoverText);

    box.onmouseover = function () {
      hoverText.style.visibility = "visible";
    };
    box.onmouseout = function () {
      hoverText.style.visibility = "hidden";
    };

    return box;
  }

  eq(other: DeletionMarker) {
    return (
      other.deletedText === this.deletedText && other.isActive === this.isActive
    );
  }

  ignoreEvent() {
    return true;
  }
}
