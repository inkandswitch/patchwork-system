import { onCleanup, createEffect } from "solid-js";

/** CodeMirror */
import { EditorView, type DecorationSet } from "@codemirror/view";
import { EditorState, type Extension, Compartment } from "@codemirror/state";

/** Automerge */
import type { Prop as AutomergeProp } from "@automerge/automerge/slim";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
  UrlHeads,
} from "@automerge/automerge-repo/slim";
import {
  createAutomergeExtension,
  createReadOnlyExtension,
  createDecorationsExtension,
  createDiffExtension,
  createScrollHighlightIntoViewExtension,
  createPresenceExtension,
} from "./extensions";

/** Utility function to lookup a value along the specified pathin an Automerge document */
const lookup = <T = any,>(doc: any, path: AutomergeProp[]): T | undefined => {
  let current = doc;
  for (const key of path) {
    current = current[key];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
};

type CodeMirrorProps<T> = {
  handle: DocHandle<T>;
  // Used by the presence extension to load peers' contact docs (their
  // presence colors live there).
  repo: Repo;
  path: AutomergeProp[];
  decorations: () => DecorationSet;
  // When provided, renders a diff of `path` against these baseline heads.
  // `null` (no fork point) renders no diff.
  baseline?: () => UrlHeads | null;
  extensions?: Extension[];
  onChangeSelection?: (from: number, to: number) => void;
  // When the returned range changes, the editor scrolls it into view -- unless
  // it's already visible. Used to follow focus driven by other views.
  scrollTarget?: () => readonly [number, number] | null;
  // identify for remote cursors; `null` disables presence.
  contactUrl?: () => AutomergeUrl | null;
  // Forces the editor read-only. A heads-pinned handle makes it read-only
  // regardless (tracked internally), so this is only needed as an override.
  readOnly?: boolean;
  withView?(view: EditorView): void;
};

export function CodeMirror<T>(props: CodeMirrorProps<T>) {
  const initialDoc = () =>
    (props.handle && (lookup(props.handle.doc(), props.path) as string)) || "";

  // Two-way sync plus undo history and read-only tracking for the handle --
  // the vendored automerge plugin owns all three, including resets when the
  // handle's backing is swapped in place. Tools must not add their own
  // history() (basicSetup includes one): the bundled history must own the
  // only copy for its reset to work.
  const [automergeExtension, createEffectReconfigureAutomerge] =
    createAutomergeExtension(
      () => props.handle,
      () => props.path,
      initialDoc
    );

  const [readOnlyExtension, createEffectReconfigureReadOnly] =
    createReadOnlyExtension(() => !!props.readOnly);

  const [decorationsExtension, createEffectReconfigureDecorations] =
    createDecorationsExtension(() => props.decorations?.());

  const [diffExtension, createEffectReconfigureDiff] = createDiffExtension(
    () => props.handle as DocHandle<unknown>,
    () => props.path,
    () => props.baseline?.() ?? null
  );

  const [
    scrollHighlightIntoViewExtension,
    createEffectScrollHighlightIntoView,
  ] = createScrollHighlightIntoViewExtension(
    () => props.scrollTarget?.() ?? null
  );

  // Read-only views are typically pinned to fixed heads, so their positions
  // don't line up with the live doc; they stay presence-free.
  const [presenceExtension, createEffectReconfigurePresence] =
    createPresenceExtension(
      () => props.handle as DocHandle<unknown>,
      () => props.path,
      () =>
        props.readOnly || props.handle.isReadOnly()
          ? null
          : (props.contactUrl?.() ?? null),
      props.repo
    );

  // Create a compartment for user-provided extensions so they can be reconfigured
  const userExtensionsCompartment = new Compartment();

  const selectionExtension = EditorView.updateListener.of((update) => {
    if (!props.onChangeSelection) return;
    // Bubble all updates to consumers (doc changes, viewport, scroll, etc.)
    if (update.selectionSet) {
      const sel = update.state.selection.main;
      props.onChangeSelection(sel.from, sel.to);
    }
  });

  const extensions = [
    selectionExtension,
    decorationsExtension,
    // automergeExtension must come before diffExtension so diff stays in sync with edits.
    automergeExtension,
    diffExtension,
    scrollHighlightIntoViewExtension,
    presenceExtension,
    userExtensionsCompartment.of(props.extensions || []),
    readOnlyExtension,
  ].filter(Boolean) as Extension[];

  const state = EditorState.create({
    doc: initialDoc(),
    extensions,
  });

  const view = new EditorView({
    state,
  });

  props.withView?.(view);

  // Create effects to reconfigure the extensions when their props change
  createEffectReconfigureAutomerge(view);
  createEffectReconfigureReadOnly(view);
  createEffectReconfigureDecorations?.(view);
  createEffectReconfigureDiff(view);
  createEffectScrollHighlightIntoView(view);
  createEffectReconfigurePresence(view);

  // Reconfigure user extensions when props.extensions changes
  createEffect(() => {
    view.dispatch({
      effects: userExtensionsCompartment.reconfigure(props.extensions || []),
    });
  });

  onCleanup(() => view.destroy());

  return view.dom;
}
