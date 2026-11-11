/**
 * `DocumentAreaRoot` — the threepane document column (document scope + top bar +
 * main view + context sidebar), extracted so it can run either directly in the
 * host (`threepane`) or as an isolated `patchwork:component` inside the iframe
 * (`threepane-isolation`).
 *
 * It takes Accessor-shaped props uniformly: the local caller passes its reactive
 * accessors; the isolated caller (the mount fn in `isolation-entry.tsx`) wraps
 * parsed-JSON values in constant accessors, which is correct because any real
 * change to the boot spec reboots the iframe.
 *
 * The right-sidebar collapse/width state, its resize handlers, and the selected
 * context-tab signal live HERE (not threaded from the host), so they survive
 * inside the isolation boundary. The left sidebar is host-side; this component
 * only reads `isLeftCollapsed` for top-bar layout.
 */

import { type AutomergeUrl } from "@automerge/automerge-repo/slim";
import { makePersisted } from "@solid-primitives/storage";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import type { ToolSlot } from "../types";
import {
  useProviderReady,
  useTaggedComponents,
  SIDEBAR_KEYS,
  COLLAPSE_CONTEXT_SIDEBAR_EVENT,
} from "../hooks";
import { useSidebarResize } from "../hooks/useSidebarResize";
import { FrameTopBar } from "./FrameTopBar";
import { ContextSidebar } from "./ContextSidebar";
import { MainDocumentView } from "./MainDocumentView";

/**
 * The reactive inputs the document area needs, shared by both the local caller
 * (`PatchworkFrame` → `DocumentAreaRoot`) and the isolated caller
 * (`IsolatedDocumentArea`, which forwards them into the boot spec). The host
 * owns these — including reading the right-sidebar seeds from localStorage — so
 * both paths receive an identical contract.
 */
export interface DocumentAreaInputs {
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  /** The host-side left sidebar's collapsed state, for top-bar layout only. */
  isLeftCollapsed: Accessor<boolean>;
  /** Seed values for the document-area-local right-sidebar state. */
  initialRightWidth: Accessor<number>;
  initialRightCollapsed: Accessor<boolean>;
}

export interface DocumentAreaRootProps extends DocumentAreaInputs {
  /**
   * Host-realm ref set when the main document view mounts, used by the host to
   * flip its left-sidebar `widgetsReady` gate. Only supplied in the local
   * (non-isolated) path; inside the iframe it stays undefined (that realm can't
   * drive the host's signal), which is correct.
   */
  setMainDocElement?: (el: HTMLElement) => void;
}

export function DocumentAreaRoot(props: DocumentAreaRootProps) {
  // ── Right-sidebar state (document-area-local) ──────────────────
  // Lives here so it survives inside the isolation boundary. Seeded from props
  // (the host reads persisted values from its localStorage and passes them in,
  // since localStorage is stubbed inside the sandboxed iframe). Persisted back
  // to localStorage when host-side; a harmless no-op inside the iframe.
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = createSignal(
    props.initialRightCollapsed()
  );
  const [rightSidebarWidth, setRightSidebarWidth] = createSignal(
    props.initialRightWidth()
  );

  createEffect(
    on(
      isRightSidebarCollapsed,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightCollapsed, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );
  createEffect(
    on(
      rightSidebarWidth,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightWidth, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );

  const sidebarResize = useSidebarResize("right", {
    isCollapsed: isRightSidebarCollapsed,
    setCollapsed: setIsRightSidebarCollapsed,
    setWidth: setRightSidebarWidth,
  });

  // The host collapses the left sidebar directly, but the right-sidebar collapse
  // state lives here, so it asks us to collapse out-of-band via a window event
  // (e.g. after a finger-tap opens a document in the left sidebar — see
  // `FrameLayout`). Only wired on the host (non-isolated) path; the sandboxed
  // iframe realm never receives the host's window events.
  onMount(() => {
    const onCollapse = () => setIsRightSidebarCollapsed(true);
    window.addEventListener(COLLAPSE_CONTEXT_SIDEBAR_EVENT, onCollapse);
    onCleanup(() =>
      window.removeEventListener(COLLAPSE_CONTEXT_SIDEBAR_EVENT, onCollapse)
    );
  });

  // Selected context-sidebar tab, lifted above the per-draft remount boundary so
  // the active tab survives branch switches even though its content remounts.
  const [selectedContextToolId, setSelectedContextToolId] = makePersisted(
    createSignal<string | undefined>(),
    { name: SIDEBAR_KEYS.contextToolId }
  );

  // Per-document scope, keyed on the selected doc URL so the whole tree
  // remounts when the user switches docs. (This copy of pkg-base has no drafts
  // plugin, so there is no draft-state or draft-overlay provider around it.)
  return (
    <Show when={props.selectedDocUrl()} keyed>
      {(_docUrl) => (
        <DocumentArea
          setMainDocElement={props.setMainDocElement}
          selectedDocUrl={props.selectedDocUrl}
          selectedToolId={props.selectedToolId}
          doctitleSlots={props.doctitleSlots}
          isLeftCollapsed={props.isLeftCollapsed}
          isRightSidebarCollapsed={isRightSidebarCollapsed}
          setIsRightSidebarCollapsed={setIsRightSidebarCollapsed}
          rightSidebarWidth={rightSidebarWidth}
          handleMouseDown={sidebarResize.handleMouseDown}
          handleToggleClick={sidebarResize.handleToggleClick}
          selectedContextToolId={selectedContextToolId}
          setSelectedContextToolId={setSelectedContextToolId}
        />
      )}
    </Show>
  );
}

// The comments + focus providers and the context (right) sidebar wrap the main
// document, so comment threads and selection resolve against it. The document
// toolbar (top bar) is in that scope too: it targets the same selected doc as
// the editor.
function DocumentArea(props: {
  setMainDocElement?: (el: HTMLElement) => void;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  isLeftCollapsed: Accessor<boolean>;
  isRightSidebarCollapsed: Accessor<boolean>;
  setIsRightSidebarCollapsed: (
    value: boolean | ((prev: boolean) => boolean)
  ) => void;
  rightSidebarWidth: Accessor<number>;
  handleMouseDown: (e: MouseEvent) => void;
  handleToggleClick: (e: MouseEvent) => void;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
}) {
  // The context sidebar exists only if something is tagged `context-tool`.
  const contextItems = useTaggedComponents("context-tool");
  const hasContext = () => contextItems().length > 0;

  // Remount key for the main view: just the selected doc. A provider that pins
  // heads streams them on the descriptors' *backing* urls and `OverlayRepo`
  // swaps handle backings in place, so scrubbing history must not change this
  // key. Stamping heads here would also override the streamed pin: in
  // `OverlayRepo`, heads on the presented url win over the backing's.
  const mainViewKey = createMemo<string | undefined>(() =>
    props.selectedDocUrl()
  );

  const [commentsProviderElement, setCommentsProviderElement] =
    createSignal<HTMLElement>();
  const isCommentsProviderReady = useProviderReady(
    "patchwork-comments-provider",
    commentsProviderElement
  );

  const [focusProviderElement, setFocusProviderElement] =
    createSignal<HTMLElement>();
  const isFocusProviderReady = useProviderReady(
    "patchwork-focus-provider",
    focusProviderElement
  );

  const areDocProvidersReady = createMemo(
    () => isCommentsProviderReady() && isFocusProviderReady()
  );

  // Components tagged `document-provider` (patch layers, say) sit above
  // everything else, so they can remap what the document views resolve.
  const documentProviders = useTaggedComponents("document-provider");
  const documentProviderIds = createMemo(
    () => documentProviders().map((c) => c.id),
    [],
    {
      equals: (a, b) =>
        a.length === b.length && a.every((id, i) => id === b[i]),
    }
  );

  return (
    <ProviderStack
      ids={documentProviderIds()}
      render={() => (
        <patchwork-view
          component="patchwork-comments-provider"
          ref={setCommentsProviderElement}
        >
          <patchwork-view
            component="patchwork-focus-provider"
            ref={setFocusProviderElement}
          >
            <Show when={areDocProvidersReady()}>
              <div class="frame__main-column">
                <div class="frame__doc-column">
                  <FrameTopBar
                    docUrl={props.selectedDocUrl}
                    toolSlots={props.doctitleSlots}
                    isLeftCollapsed={props.isLeftCollapsed}
                    hasContext={hasContext}
                    isRightCollapsed={props.isRightSidebarCollapsed}
                    onToggleRight={() =>
                      props.setIsRightSidebarCollapsed((v) => !v)
                    }
                  />

                  <div class="main-area">
                    <MainDocumentView
                      viewKey={mainViewKey}
                      selectedDocUrl={props.selectedDocUrl}
                      toolId={props.selectedToolId}
                      // Always pass a function ref. Passing `ref={undefined}`
                      // (the isolated path, where no host ref is threaded)
                      // makes Solid's component-ref codegen fall back to
                      // assigning the prop, which throws on the getter-only
                      // reactive props object. A no-op wrapper avoids that.
                      ref={(el) => props.setMainDocElement?.(el)}
                    />
                  </div>
                </div>

                <Show when={hasContext()}>
                  <ContextSidebar
                    selectedToolId={props.selectedContextToolId}
                    setSelectedToolId={props.setSelectedContextToolId}
                    isCollapsed={props.isRightSidebarCollapsed}
                    width={props.rightSidebarWidth}
                    onMouseDown={props.handleMouseDown}
                    onToggleClick={props.handleToggleClick}
                    onCollapse={() => props.setIsRightSidebarCollapsed(true)}
                  />
                </Show>
              </div>
            </Show>
          </patchwork-view>
        </patchwork-view>
      )}
    />
  );
}

// Mounts each provider component inside the one before it, rendering what's
// beneath only once each has mounted, so nothing resolves around it.
function ProviderStack(props: {
  ids: readonly string[];
  render: () => JSX.Element;
}): JSX.Element {
  return (
    <Show when={props.ids[0]} keyed fallback={props.render()}>
      {(id) => {
        const [host, setHost] = createSignal<HTMLElement>();
        const ready = useProviderReady(id, host);
        return (
          <patchwork-view component={id} ref={setHost}>
            <Show when={ready()}>
              <ProviderStack ids={props.ids.slice(1)} render={props.render} />
            </Show>
          </patchwork-view>
        );
      }}
    </Show>
  );
}
