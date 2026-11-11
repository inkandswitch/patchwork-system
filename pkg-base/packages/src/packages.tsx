// The packages tool: a toolbar (filter, view tabs, origin chips) over one of
// three views of the live registries, plus the broken-module boxes and the
// install modal. The data comes from usePackageData / useBrokenModules; the
// views and their pieces live in views.tsx, broken-modules.tsx and bits.tsx.

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import "./styles.css";
import { deactivateModule, type ToolElement, type ToolHandle } from "./registry.ts";
import {
  isInstallableUrl,
  moduleKey,
  ORIGIN_HINT,
  ORIGIN_LABEL,
  type Origin,
} from "./origin.ts";
import { usePackageData } from "./use-package-data.ts";
import { useBrokenModules } from "./use-broken-modules.ts";
import {
  countOrigins,
  filterEntries,
  VIEW_LABEL,
  type OriginFilter,
  type SortKey,
  type View,
} from "./model.ts";
import { Copyable, PackagesProvider, type PackagesActions } from "./bits.tsx";
import { ByPackage, ByType, Table } from "./views.tsx";
import { BrokenModules } from "./broken-modules.tsx";
import { InstallModal } from "./install-modal.tsx";

const ORIGIN_CHIPS: [OriginFilter, string][] = [
  ["all", "all"],
  ["installed", ORIGIN_LABEL.installed],
  ["core", ORIGIN_LABEL.core],
  ["ephemeral", ORIGIN_LABEL.ephemeral],
];

export function Packages(props: {
  handle: ToolHandle;
  element: ToolElement;
}): JSX.Element {
  const data = usePackageData(props.handle);
  const broken = useBrokenModules(() => data.doc()?.modules, data.snapshot);

  // --- controls --------------------------------------------------------------
  const [view, setView] = createSignal<View>("packages");
  const [search, setSearch] = createSignal("");
  const [originFilter, setOriginFilter] = createSignal<OriginFilter>("all");
  const [sortKey, setSortKey] = createSignal<SortKey>("name");
  const [sortAsc, setSortAsc] = createSignal(true);

  const originCounts = createMemo(() => countOrigins(data.enriched()));
  const filtered = createMemo(() =>
    filterEntries(data.enriched(), search(), originFilter())
  );

  const stats = createMemo(() => {
    const rows = filtered();
    const packages = new Set<string>();
    const registries = new Set<string>();
    for (const e of rows) {
      packages.add(e.importUrl ?? "∅");
      registries.add(e.registry);
    }
    return {
      plugins: rows.length,
      total: data.enriched().length,
      packages: packages.size,
      registries: registries.size,
    };
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey() === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  // --- what the pieces can do (provided to bits.tsx) -------------------------
  const [copied, setCopied] = createSignal<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));

  const actions: PackagesActions = {
    copied,
    copy(value) {
      try {
        void navigator.clipboard?.writeText(value);
      } catch {
        // clipboard may be unavailable; the click still gives visual feedback
      }
      setCopied(value);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(null), 1200);
    },
    headsFor: data.headsFor,
    openDoc(url) {
      props.element.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: { url },
          bubbles: true,
          composed: true,
        })
      );
    },
    // Remove a module from the settings doc you're viewing AND deactivate its
    // plugins from the live registries so it disappears now, not just on
    // reload. The doc stores bare module URLs while a plugin's importUrl is
    // heads-pinned, so both sides match by key.
    uninstall(importUrl) {
      const key = moduleKey(importUrl);
      if (!key) return;
      props.handle.change((d) => {
        if (!Array.isArray(d.modules)) return;
        const idx = d.modules.findIndex((m) => moduleKey(m) === key);
        if (idx >= 0) d.modules.splice(idx, 1);
      });
      deactivateModule(importUrl);
    },
  };

  // --- install ---------------------------------------------------------------
  // null while closed; otherwise the URL the modal opens with.
  const [installUrl, setInstallUrl] = createSignal<string | null>(null);

  const install = (url: string) => {
    const key = moduleKey(url);
    if (!key) return;
    props.handle.change((d) => {
      if (!Array.isArray(d.modules)) d.modules = [];
      if (!d.modules.some((m) => moduleKey(m) === key)) d.modules.push(url);
    });
  };

  // Pasting a package URL into the filter is a shortcut to the install modal.
  // Only a paste does it: typing a URL just filters by it. We stop the paste
  // before it reaches the input, so the box keeps whatever filter text it had
  // and there's no URL left in the DOM value to clear.
  const onSearchPaste = (event: ClipboardEvent) => {
    const pasted = event.clipboardData?.getData("text")?.trim() ?? "";
    if (!isInstallableUrl(pasted)) return;
    event.preventDefault();
    setInstallUrl(pasted);
  };

  // --- render ----------------------------------------------------------------
  return (
    <PackagesProvider value={actions}>
      <div class="pw-packages">
        <header class="pw-packages__head">
          <div class="pw-packages__toolbar">
            <input
              class="pw-packages__search"
              type="text"
              placeholder="Filter… or paste a URL to install"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onPaste={onSearchPaste}
            />
            <div class="pw-packages__stats">
              <span>
                <strong>{stats().plugins}</strong>
                <Show when={stats().plugins !== stats().total}>
                  <span class="pw-packages__stat-of"> / {stats().total}</span>
                </Show>{" "}
                plugins
              </span>
              <span>
                <strong>{stats().packages}</strong> packages
              </span>
              <span>
                <strong>{stats().registries}</strong> types
              </span>
            </div>
          </div>

          <div class="pw-packages__tabbar">
            <div class="pw-packages__tabs" role="tablist">
              <For each={["packages", "registries", "table"] as View[]}>
                {(v) => (
                  <button
                    class="pw-packages__tab"
                    data-view={v}
                    data-active={view() === v ? "" : undefined}
                    onClick={() => setView(v)}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                )}
              </For>
            </div>
            <div class="pw-packages__origins">
              <For each={ORIGIN_CHIPS}>
                {([key, label]) => (
                  <button
                    class="pw-packages__origin-chip"
                    data-origin={key === "all" ? undefined : key}
                    data-active={originFilter() === key ? "" : undefined}
                    title={key === "all" ? undefined : ORIGIN_HINT[key as Origin]}
                    onClick={() => setOriginFilter(key)}
                  >
                    {label}
                    <Show when={key !== "all"}>
                      <span class="pw-packages__origin-count">
                        {originCounts()[key as Origin]}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </header>

        <Show
          when={
            data.isCustomSystemPackageList() || !data.isWatchedPackageList()
          }
        >
          <div class="pw-package-notices">
            <Show when={data.isCustomSystemPackageList()}>
              <div class="pw-package-notice" role="status">
                Using a custom system package list.
                <Copyable
                  value={data.systemPackageListUrl()!}
                  class="pw-package-notice__url"
                  title="System package list URL — click to copy"
                />
              </div>
            </Show>
            <Show when={!data.isWatchedPackageList()}>
              <div class="pw-package-notice" role="alert">
                This package list is not being watched by this window.
              </div>
            </Show>
          </div>
        </Show>

        <Show
          when={view() === "packages" && broken.brokenModules().length > 0}
        >
          <BrokenModules
            modules={broken.brokenModules()}
            infoFor={broken.infoFor}
          />
        </Show>

        <Show
          when={filtered().length > 0}
          fallback={
            <div class="pw-packages__empty">
              <Show
                when={data.enriched().length > 0}
                fallback={<>No plugins are registered yet.</>}
              >
                Nothing matches these filters.
              </Show>
            </div>
          }
        >
          <Show when={view() === "packages"}>
            <ByPackage entries={filtered()} />
          </Show>
          <Show when={view() === "registries"}>
            <ByType entries={filtered()} />
          </Show>
          <Show when={view() === "table"}>
            <Table
              entries={filtered()}
              sortKey={sortKey()}
              sortAsc={sortAsc()}
              onSort={toggleSort}
            />
          </Show>
        </Show>

        <Show when={installUrl() !== null}>
          <InstallModal
            initialUrl={installUrl()!}
            installedKeys={data.installedKeys()}
            onAdd={install}
            onClose={() => setInstallUrl(null)}
          />
        </Show>
      </div>
    </PackagesProvider>
  );
}
