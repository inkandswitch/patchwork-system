import "@inkandswitch/patchwork-elements";
import { useDocHandle, useDocument } from "solid-automerge";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type {
  OpenDocumentEvent,
  OpenDocumentEventDetail,
} from "@inkandswitch/patchwork-elements";
import type { AccountDoc, ThreepaneConfigDoc, ToolSlot } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useMainDocMounted,
  SIDEBAR_KEYS,
  COLLAPSE_CONTEXT_SIDEBAR_EVENT,
  getStoredNumber,
  getStoredBoolean,
  DEFAULT_SIDEBAR_WIDTH,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { SidebarWidgets } from "./components/SidebarWidgets";
import { DocumentAreaRoot } from "./components/DocumentAreaRoot";
import { IsolatedDocumentArea } from "./components/IsolatedDocumentArea";
import { MainDocumentView } from "./components/MainDocumentView";
import { Tray } from "./components/Tray";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import { render } from "solid-js/web";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { ensureThreepaneConfig } from "./account/ensureThreepaneConfig";
import { seedExampleDocuments } from "./account/seedExampleDocuments";
import { handleAddToSidebar } from "./account/addToSidebar";
import { ensureFrameStyles } from "./ensureFrameStyles";
import { useHandleDoc } from "./hooks/useHandleDoc";

type SelectedView = {
  url: AutomergeUrl;
  toolId: string | null;
};

type SidebarResize = ReturnType<typeof useSidebarResize>;
type SidebarState = ReturnType<typeof useSidebarState>;

// Keep this tiny hook local to the frame chunk. Importing it from the shared
// hooks chunk has produced an undefined binding in Safari before the frame can
// mount its providers.
const useFrameProviderReady = (
  componentId: string,
  element: Accessor<HTMLElement | undefined>
): Accessor<boolean> => {
  const [isReady, setReady] = createSignal(false);

  createEffect(() => {
    const el = element();
    if (!el) return;
    setReady(false);
    const onMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ componentId?: string }>).detail;
      if (detail?.componentId !== componentId) return;
      setReady(true);
    };
    el.addEventListener("patchwork:mounted", onMounted);
    onCleanup(() => el.removeEventListener("patchwork:mounted", onMounted));
  });

  return isReady;
};

// Fire a `patchwork:open-document` request from an account-bar button. Bubbles +
// composed so it reaches the footer intercept (isolation → popover) or the
// selected-doc provider (otherwise → main frame), matching the sideboard tool.
function dispatchOpen(el: HTMLElement, detail: OpenDocumentEventDetail) {
  el.dispatchEvent(
    new CustomEvent("patchwork:open-document", {
      detail,
      bubbles: true,
      composed: true,
    })
  );
}

export function PatchworkFrame({
  handle,
  repo,
  ...props
}: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
  isolation?: boolean;
}) {
  ensureFrameStyles();
  const accountDocUrl = handle.url;

  const [accountProviderElement, setAccountProviderElement] =
    createSignal<HTMLElement>();
  const isAccountProviderReady = useFrameProviderReady(
    "patchwork-account-provider",
    accountProviderElement
  );

  const [toolStorageProviderElement, setToolStorageProviderElement] =
    createSignal<HTMLElement>();
  const isToolStorageProviderReady = useFrameProviderReady(
    "patchwork-tool-storage-provider",
    toolStorageProviderElement
  );

  const [selectedDocProviderElement, setSelectedDocProviderElement] =
    createSignal<HTMLElement>();
  const isSelectedDocProviderReady = useFrameProviderReady(
    "patchwork-selected-doc-provider",
    selectedDocProviderElement
  );

  // patchwork-worker-provider isn't waited on. It listens at the document, so
  // mount order doesn't matter, and patchwork-view sends no event when a
  // component fails to load, so waiting on it can leave the frame blank.
  const areProvidersReady = createMemo(
    () =>
      isSelectedDocProviderReady() &&
      isAccountProviderReady() &&
      isToolStorageProviderReady()
  );

  return (
    <div class="frame-shell">
      <aside class="frame-warning-banner">
        research grade software. do not share links. sharing a doc is sharing
        your account.
        <Show when={props.isolation}>
          {" "}
          isolation is highly experimental. if things are broken, switch back to
          wild west.
        </Show>
      </aside>
      <div class="frame">
        {/*
        Outermost providers: wrap both sidebars and the main area so that
        `patchwork:open-document` events from anywhere (and the matching
        `patchwork:selected-doc` subscriptions) reach them. The comments and
        focus providers are deliberately *not* here - they live inside the
        per-draft overlay (inside `DocumentAreaRoot`) so branch comments resolve
        against the draft's clone. `patchwork-view` defaults to
        `display: contents`, so these wrappers are layout-neutral.
      */}
        <patchwork-view
          component="patchwork-selected-doc-provider"
          ref={setSelectedDocProviderElement}
        >
          <patchwork-view
            component="patchwork-account-provider"
            doc-url={accountDocUrl}
            ref={setAccountProviderElement}
          >
            <patchwork-view
              component="patchwork-tool-storage-provider"
              doc-url={accountDocUrl}
              ref={setToolStorageProviderElement}
            >
              {/*
                Runs workers (like the LLM's) on the host for
                patchwork:worker-channel subscriptions, including ones relayed
                out of isolation. It wraps the document area because this
                element is the ctx a worker spec's open(ctx) gets.
              */}
              <patchwork-view component="patchwork-worker-provider">
                <Show when={areProvidersReady()}>
                  <PatchworkFrameInner
                    handle={handle}
                    repo={repo}
                    isolation={props.isolation}
                  />
                </Show>
              </patchwork-view>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      </div>
    </div>
  );
}

function PatchworkFrameInner(props: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
  isolation?: boolean;
}) {
  const accountDocHandle = useDocHandle<AccountDoc>(() => props.handle.url, {
    repo: props.repo,
  });

  // Lazily populate subdoc fields (rootFolderUrl, moduleSettingsUrl, contactUrl)
  // on first mount, then create the threepane layout config doc and migrate the
  // legacy account arrays into it (non-destructive — old fields stay so older
  // builds keep working).
  void (async () => {
    await ensureThreepaneConfig(props.handle, props.repo);
    await seedExampleDocuments(props.handle, props.repo);
  })().catch((err) => {
    console.error("frame: account bootstrap failed", err);
  });

  const accountDoc = useHandleDoc(accountDocHandle);
  const accountDocUrl = props.handle.url;

  // The threepane layout config doc (sidebar widgets / context tabs / doctitle
  // tools).
  const threepaneUrl = () => accountDoc()?.tools?.["threepane"];
  const threepaneConfigHandle = useDocHandle<ThreepaneConfigDoc>(
    () => threepaneUrl(),
    { repo: props.repo }
  );
  const threepaneConfig = useHandleDoc(threepaneConfigHandle);

  // Derived layout lanes, read from the threepane config doc. Slots are a
  // [toolId, docId] tuple or a bare component-id string; SlotView decides how
  // to render each. `tray` is the system tray's explicit ordered list of tools,
  // rendered by the one stable host-owned instance below.
  const doctitleSlots = () => threepaneConfig()?.doctitle?.tools;
  const sidebarWidgets = (): ToolSlot[] =>
    threepaneConfig()?.sidebar?.widgets ?? [];
  const traySlots = (): ToolSlot[] => threepaneConfig()?.tray ?? [];
  const rootFolderUrl = () => accountDoc()?.rootFolderUrl;

  const sidebarState = useSidebarState();
  const sidebarResize = useSidebarResize("left", {
    isCollapsed: sidebarState.isSidebarCollapsed,
    setCollapsed: sidebarState.setIsSidebarCollapsed,
    setWidth: sidebarState.setLeftSidebarWidth,
  });

  let element!: HTMLDivElement;
  const [selectedView, setSelectedView] = createSignal<SelectedView | null>(
    null
  );

  // Under isolation the main document area lives inside a sandboxed iframe, so
  // host-realm chrome tools opened from the account bar (account picker /
  // Packages / Settings) must NOT be routed into it as a `selected-view` — they
  // need host repo access the iframe is denied. FrameLayout intercepts their
  // `patchwork:open-document` events (stopping them before they reach the
  // selected-doc provider) and surfaces them here, floating in a popover over
  // the frame instead. Off-isolation this stays null and the events open in the
  // main frame as usual.
  const [popoverView, setPopoverView] = createSignal<SelectedView | null>(null);

  onMount(() => {
    const unsubscribeSelectedView = subscribe<SelectedView | null>(
      element,
      { type: "patchwork:selected-view" },
      (view) => setSelectedView(view)
    );

    onCleanup(unsubscribeSelectedView);
    onCleanup(handleAddToSidebar(element, props.repo, props.handle));
  });

  const selectedDocUrl = () => selectedView()?.url;
  const selectedToolId = () => selectedView()?.toolId ?? undefined;

  // Right-sidebar seeds, read from host localStorage. The host owns this read
  // and hands the values to whichever document-area path renders — the local
  // `DocumentAreaRoot`, or the isolated root via `IsolatedDocumentArea`'s boot
  // spec (localStorage is stubbed inside the sandboxed iframe, so the isolated
  // path can't read it itself). The right-sidebar collapse/width state and the
  // selected context tab then live *inside* `DocumentAreaRoot`, so the context
  // sidebar — and its chrome — sit inside the isolation boundary and are
  // sandboxed alongside the main view. The system tray is separate trusted host
  // chrome in the left sidebar (see `FrameLayout`).
  const initialRightWidth = () =>
    getStoredNumber(SIDEBAR_KEYS.rightWidth, DEFAULT_SIDEBAR_WIDTH);
  const initialRightCollapsed = () =>
    getStoredBoolean(SIDEBAR_KEYS.rightCollapsed);

  // Suspend the sidebar widgets until the main document has settled (mounted or
  // failed to mount), so the primary column wins the initial render race. With
  // no document selected there's nothing to wait for, so the widgets show
  // immediately. Latched: once revealed they stay mounted across later doc
  // switches — we only want to win the *first* race, not re-suspend every time.
  //
  // Under isolation the main document lives inside the iframe, so the host-side
  // mount ref can never be set; we reveal the widgets immediately instead of
  // gating on a mount that will never reach this realm.
  const [mainDocElement, setMainDocElement] = createSignal<HTMLElement>();
  const isMainDocMounted = useMainDocMounted(mainDocElement, selectedDocUrl);
  const [widgetsReady, setWidgetsReady] = createSignal(false);
  createEffect(() => {
    if (widgetsReady()) return;
    if (props.isolation || !selectedDocUrl() || isMainDocMounted())
      setWidgetsReady(true);
  });

  return (
    <div ref={element} style={{ display: "contents" }}>
      {/*
        FrameLayout (the left sidebar + its toggle) is rendered ONCE, outside
        the doc-selection Show. Selecting the first document only swaps the main
        column below; it must not tear down and rebuild the entire left sidebar
        (widgets, account bar) — that's a full-world remount on first click.
      */}
      <FrameLayout
        accountDocUrl={accountDocUrl}
        sidebarState={sidebarState}
        sidebarResize={sidebarResize}
        sidebarWidgets={sidebarWidgets}
        traySlots={traySlots}
        configHandle={threepaneConfigHandle}
        rootFolderUrl={rootFolderUrl}
        widgetsReady={widgetsReady}
        contactUrl={() => accountDoc()?.contactUrl}
        moduleSettingsUrl={() => accountDoc()?.moduleSettingsUrl}
        isolation={props.isolation}
        onInterceptOpen={setPopoverView}
      >
        <Show
          when={selectedDocUrl()}
          fallback={
            <div class="main-area">
              <MainDocumentView
                viewKey={selectedDocUrl}
                selectedDocUrl={selectedDocUrl}
                toolId={selectedToolId}
                ref={setMainDocElement}
              />
            </div>
          }
        >
          {/*
            Document area: isolated (rendered inside a sandboxed iframe) or local
            (rendered directly). `isolation` is fixed per tool instance. Both
            paths render the whole main column (doc column + context sidebar) and
            own the right-sidebar state, seeded from the host localStorage reads
            above — so under isolation the context sidebar lives *inside* the
            iframe, sandboxed with the main view. The local path additionally
            threads `setMainDocElement` for the host's widgetsReady race (the
            iframe can't drive that host ref).
          */}
          <Show
            when={props.isolation}
            fallback={
              <DocumentAreaRoot
                setMainDocElement={setMainDocElement}
                selectedDocUrl={selectedDocUrl}
                selectedToolId={selectedToolId}
                doctitleSlots={doctitleSlots}
                isLeftCollapsed={sidebarState.isSidebarCollapsed}
                initialRightWidth={initialRightWidth}
                initialRightCollapsed={initialRightCollapsed}
              />
            }
          >
            <IsolatedDocumentArea
              contactUrl={accountDoc()?.contactUrl}
              selectedDocUrl={selectedDocUrl}
              selectedToolId={selectedToolId}
              doctitleSlots={doctitleSlots}
              isLeftCollapsed={sidebarState.isSidebarCollapsed}
              initialRightWidth={initialRightWidth}
              initialRightCollapsed={initialRightCollapsed}
            />
          </Show>
        </Show>
      </FrameLayout>

      <Show when={popoverView()}>
        {(view) => (
          <FramePopover view={view()} onClose={() => setPopoverView(null)} />
        )}
      </Show>
    </div>
  );
}

// The isolation-mode chrome popover: floats a host-realm tool (account picker /
// Packages / Settings) over the frame on a dimmed, theme-tinted wash so it can
// run in the host realm instead of being routed into the isolated main frame.
// Click the backdrop or press Escape to dismiss.
function FramePopover(props: { view: SelectedView; onClose: () => void }) {
  // The tool the popover currently renders the doc with. Seeded from the
  // intercepted open request and re-pointed by the "Open with" picker in the
  // toolbar (below) without leaving the popover. Reset whenever a fresh view is
  // opened.
  const [toolId, setToolId] = createSignal(props.view.toolId ?? undefined);
  createEffect(() => setToolId(props.view.toolId ?? undefined));

  let popoverEl: HTMLDivElement | undefined;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    // The "Open with" picker (and any tool inside the popover) fires
    // `patchwork:open-document`. Catch it here and re-point the popover in place
    // rather than letting it bubble out to the selected-doc provider — these are
    // host-realm chrome tools that must not be routed into the isolated main
    // frame (the whole reason this popover exists).
    const el = popoverEl;
    if (!el) return;
    const onOpen = (event: OpenDocumentEvent) => {
      const { url, toolId: nextToolId } = event.detail;
      if (!url) return;
      event.stopPropagation();
      setToolId(nextToolId ?? undefined);
    };
    el.addEventListener("patchwork:open-document", onOpen);
    onCleanup(() => el.removeEventListener("patchwork:open-document", onOpen));
  });

  return (
    <div class="frame__popover-backdrop" onClick={() => props.onClose()}>
      <div
        ref={popoverEl}
        class="frame__popover"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/*
          "Open with" lets you re-point the popover at a different tool for the
          same doc. Its `patchwork:open-document` event is intercepted above and
          swaps `toolId` below in place.
        */}
        <div class="frame__popover-toolbar">
          <patchwork-view doc-url={props.view.url} tool-id="doc-openwith" />
        </div>
        <div class="frame__popover-body">
          <patchwork-view doc-url={props.view.url} tool-id={toolId()} />
        </div>
      </div>
    </div>
  );
}

// Host-side frame chrome: the left (account) sidebar plus a slot for the main
// column (`children`). Rendered once and kept mounted across the no-doc → doc
// transition; only its `children` (the main column) swap. The right context
// sidebar/tray are host chrome rendered by `PatchworkFrameInner`.
export function FrameLayout(props: {
  accountDocUrl: AutomergeUrl;
  sidebarState: SidebarState;
  sidebarResize: SidebarResize;
  sidebarWidgets: Accessor<ToolSlot[]>;
  /** The system-tray tools, configured on the threepane config doc. */
  traySlots: Accessor<ToolSlot[]>;
  configHandle: Accessor<DocHandle<ThreepaneConfigDoc> | undefined>;
  rootFolderUrl: Accessor<AutomergeUrl | undefined>;
  widgetsReady: Accessor<boolean>;
  /** Account subdocs for the inlined account bar (avatar + Packages buttons). */
  contactUrl: Accessor<AutomergeUrl | undefined>;
  moduleSettingsUrl: Accessor<AutomergeUrl | undefined>;
  /** Fixed per tool instance: whether the main document area is isolated. */
  isolation?: boolean;
  /** Isolation only: called with an account-bar tool to open in the popover. */
  onInterceptOpen?: (view: SelectedView) => void;
  children: JSX.Element;
}) {
  const isCollapsed = props.sidebarState.isSidebarCollapsed;

  // The system tray is docked to the frame's bottom-left, OUTSIDE the collapsing
  // sidebar. Its tools are configured on the threepane config doc's `tray`
  // array. We use the list here to reserve matching space at the sidebar's
  // bottom (so the account bar clears the dock when open) and to skip the dock
  // entirely when nothing is configured. The dock stays mounted when the sidebar
  // closes — it's hidden with CSS (below), not unmounted, so its tools keep
  // running.
  const hasTray = () => props.traySlots().length > 0;

  // One `patchwork:open-document` listener on the sidebar content, for two jobs:
  //
  // 1. Isolation only: events from the account bar (account picker / Packages /
  //    Settings) are stopped here and handed to the host-side popover. Left to
  //    propagate they'd select a view for the isolated main frame — the
  //    sandboxed iframe — where these host-realm chrome tools can't run.
  //    Off-isolation they pass straight through to the selected-doc provider.
  //
  // 2. Narrow viewports: when the left sidebar covers most of the frame (>75%
  //    of the viewport width — acting as a full-screen overlay rather than a
  //    side rail), opening a document from it collapses both sidebars so the
  //    document takes over. Account-bar events intercepted in (1) don't.
  //
  // The sidebar content (account bar included) is unmounted while collapsed and
  // rebuilt on every re-expand (see `Sidebar`), so this effect rebinds on the
  // collapse state rather than once at mount — otherwise the first collapse
  // destroys the element the listener was on and it never fires again.
  let sidebarContentEl: HTMLDivElement | undefined;
  let footerEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (isCollapsed()) return;
    const el = sidebarContentEl;
    if (!el) return;
    const footer = footerEl;
    const onOpen = (event: OpenDocumentEvent) => {
      const { url, toolId } = event.detail;
      if (
        props.isolation &&
        url &&
        footer &&
        event.composedPath().includes(footer)
      ) {
        event.stopPropagation();
        props.onInterceptOpen?.({ url, toolId: toolId ?? null });
        return;
      }
      if (el.getBoundingClientRect().width <= window.innerWidth * 0.75) return;
      props.sidebarState.setIsSidebarCollapsed(true);
      window.dispatchEvent(new CustomEvent(COLLAPSE_CONTEXT_SIDEBAR_EVENT));
    };
    el.addEventListener("patchwork:open-document", onOpen);
    onCleanup(() => el.removeEventListener("patchwork:open-document", onOpen));
  });

  return (
    <>
      {/*
        The left toggle is pinned to the frame's top-left corner (absolute,
        outside the collapsing sidebar) so it holds the same spot whether the
        sidebar is open or closed. The title, in the top bar, slides up against
        it as the sidebar closes rather than travelling the full sidebar width.
      */}
      <button
        type="button"
        class="frame__sidebar-toggle frame__left-toggle"
        title={isCollapsed() ? "Show sidebar" : "Hide sidebar"}
        aria-label={isCollapsed() ? "Show sidebar" : "Hide sidebar"}
        aria-pressed={!isCollapsed()}
        onClick={() => props.sidebarState.setIsSidebarCollapsed((v) => !v)}
      >
        <PanelLeftIcon />
      </button>

      <Sidebar
        side="left"
        isCollapsed={isCollapsed}
        width={props.sidebarState.leftSidebarWidth}
        onMouseDown={props.sidebarResize.handleMouseDown}
        onToggleClick={props.sidebarResize.handleToggleClick}
      >
        <div
          class="threepane-sidebar"
          classList={{ "threepane-sidebar--has-tray": hasTray() }}
          ref={sidebarContentEl}
        >
          <SidebarWidgets
            widgets={props.sidebarWidgets}
            configHandle={props.configHandle}
            rootFolderUrl={props.rootFolderUrl}
            ready={props.widgetsReady}
          />
          {/*
            The account bar — avatar (account picker) + Packages + Settings —
            pinned to the sidebar's bottom. Inlined here directly rather than
            mounted as the `chee/account-bar` sideboard tool, so the frame owns
            the markup. Each button dispatches a `patchwork:open-document` event
            (bubbles + composed), which the footer intercepts into the popover
            under isolation, or lets bubble to the selected-doc provider
            otherwise — exactly the flow the sideboard tool had.
          */}
          <div class="threepane-sidebar__footer" ref={footerEl}>
            <footer class="threepane-account-bar">
              <Show when={props.contactUrl()}>
                {(contactUrl) => (
                  <button
                    type="button"
                    class="threepane-account-bar__button threepane-account-bar__avatar"
                    title="Account"
                    aria-label="Account"
                    onClick={(e) =>
                      dispatchOpen(e.currentTarget, {
                        url: props.accountDocUrl,
                        toolId: "account-picker",
                      })
                    }
                  >
                    <patchwork-view
                      doc-url={contactUrl()}
                      tool-id="contact-avatar"
                    />
                  </button>
                )}
              </Show>

              <Show when={props.moduleSettingsUrl()}>
                {(moduleSettingsUrl) => (
                  <button
                    type="button"
                    class="threepane-account-bar__button"
                    onClick={(e) =>
                      dispatchOpen(e.currentTarget, {
                        url: moduleSettingsUrl(),
                        toolId: "packages",
                      })
                    }
                  >
                    Packages
                  </button>
                )}
              </Show>

              <button
                type="button"
                class="threepane-account-bar__button"
                onClick={(e) =>
                  dispatchOpen(e.currentTarget, {
                    url: props.accountDocUrl,
                    toolId: "frame-configurator",
                  })
                }
              >
                Settings
              </button>
            </footer>
          </div>
        </div>
      </Sidebar>

      {/*
        The system tray, docked to the frame's bottom-left. Rendered here —
        outside the collapsing <Sidebar> — as trusted host chrome, one stable
        instance. When the sidebar is open the dock spans its width and sits in
        the space reserved by `threepane-sidebar--has-tray`, above the account
        bar. When the sidebar closes the dock is hidden (`--collapsed` fades it
        out at once) rather than unmounted, so the tray is invisible but its
        tools keep running. On open it fades back in only after the sidebar's
        expand animation finishes, so it never flashes over the growing sidebar.
      */}
      <Show when={hasTray()}>
        <div
          class="frame__tray-dock"
          classList={{ "frame__tray-dock--collapsed": isCollapsed() }}
          style={{ width: `${props.sidebarState.leftSidebarWidth()}px` }}
        >
          <Tray slots={props.traySlots} />
        </div>
      </Show>

      {props.children}
    </>
  );
}

// lucide `panel-left`
function PanelLeftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--studio-chrome-line)"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

export function renderPatchworkFrame(
  isolation?: boolean
): ToolImplementation<AccountDoc> {
  return (handle, element) => {
    return render(
      () => (
        <PatchworkFrame
          handle={handle}
          repo={element.repo}
          isolation={isolation}
        />
      ),
      element
    );
  };
}
