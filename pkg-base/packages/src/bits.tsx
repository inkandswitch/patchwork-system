// Small pieces every view uses: badges, click-to-copy, a plugin row, a source
// line, the open/delete buttons. The things they do to the outside world
// (copy, open a doc, uninstall, look up heads) come from PackagesContext, which
// the Packages component provides once.

import {
  createContext,
  createMemo,
  createSignal,
  For,
  Show,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import {
  bareModuleUrl,
  isAutomergeUrl,
  ORIGIN_HINT,
  ORIGIN_LABEL,
  pinnedModuleUrl,
  type Origin,
} from "./origin.ts";
import { datatypesLabel, prettyType, type Enriched } from "./model.ts";
import type { PluginLite } from "./pkg-meta.ts";

export interface PackagesActions {
  /** The value most recently copied, for a moment, so it can say "copied!". */
  copied: Accessor<string | null>;
  copy(value: string): void;
  /** The heads a module is at: pinned in the url, or live from the repo. */
  headsFor(importUrl: string | undefined): string[];
  openDoc(url: string): void;
  /** Take a module out of the viewed package list and the live registries. */
  uninstall(importUrl: string | undefined): void;
}

const PackagesContext = createContext<PackagesActions>();
export const PackagesProvider = PackagesContext.Provider;

function useActions(): PackagesActions {
  const actions = useContext(PackagesContext);
  if (!actions) throw new Error("packages: bits used outside PackagesProvider");
  return actions;
}

// Render a list, but only the first `limit` items until "show more" is clicked.
// The toggle is a <li> so it sits validly inside the surrounding <ul>.
export function Collapsible<T>(props: {
  each: T[];
  limit?: number;
  render: (item: T) => JSX.Element;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const limit = () => props.limit ?? 4;
  const shown = createMemo(() =>
    expanded() ? props.each : props.each.slice(0, limit())
  );
  const hidden = () => Math.max(0, props.each.length - limit());
  return (
    <>
      <For each={shown()}>{(item) => props.render(item)}</For>
      <Show when={hidden() > 0}>
        <li class="pw-more">
          <button class="pw-more__btn" onClick={() => setExpanded((v) => !v)}>
            {expanded() ? "show less" : `show ${hidden()} more`}
          </button>
        </li>
      </Show>
    </>
  );
}

export function OriginBadge(props: { origin: Origin }): JSX.Element {
  return (
    <span
      class="pw-packages__origin"
      data-origin={props.origin}
      title={ORIGIN_HINT[props.origin]}
    >
      {ORIGIN_LABEL[props.origin]}
    </span>
  );
}

export function UnlistedBadge(): JSX.Element {
  return (
    <span
      class="pw-packages__unlisted"
      title="Hidden from new-document menus and pickers"
    >
      unlisted
    </span>
  );
}

export function Copyable(props: {
  value: string;
  label?: string;
  class?: string;
  title?: string;
}): JSX.Element {
  const { copied, copy } = useActions();
  return (
    <code
      class={`pw-packages__copy ${props.class ?? ""}`}
      classList={{ "is-copied": copied() === props.value }}
      title={props.title ?? "Click to copy"}
      onClick={() => copy(props.value)}
    >
      {copied() === props.value ? "copied!" : props.label ?? props.value}
    </code>
  );
}

/** A plugin that's registered right now. */
export function PluginRow(props: { plugin: Enriched }): JSX.Element {
  const dts = () => datatypesLabel(props.plugin.supportedDatatypes);
  return (
    <li class="pw-plugin">
      <span class="pw-plugin__dot" data-origin={props.plugin.origin} />
      <span
        class="pw-plugin__name"
        classList={{ "is-unlisted": props.plugin.unlisted }}
      >
        {props.plugin.name}
      </span>
      <span class="pw-plugin__type">{prettyType(props.plugin.type)}</span>
      <Show when={props.plugin.unlisted}>
        <UnlistedBadge />
      </Show>
      <Copyable
        value={props.plugin.id}
        class="pw-plugin__id"
        title="Plugin id — click to copy"
      />
      <Show when={dts()}>
        <span class="pw-plugin__supports">
          <span class="pw-plugin__supports-label">supports</span> {dts()}
        </span>
      </Show>
    </li>
  );
}

/**
 * A plugin a package says it has but which isn't registered: from a preview,
 * or from the package.json of a module that failed to import.
 */
export function DeclaredPluginRow(props: { plugin: PluginLite }): JSX.Element {
  const dts = () => datatypesLabel(props.plugin.supportedDatatypes);
  return (
    <li class="pw-install__plugin">
      <span
        class="pw-install__plugin-name"
        classList={{ "is-unlisted": props.plugin.unlisted }}
      >
        {props.plugin.name || props.plugin.id}
      </span>
      <Show when={props.plugin.type}>
        <span class="pw-plugin__type">{prettyType(props.plugin.type!)}</span>
      </Show>
      <Show when={props.plugin.unlisted}>
        <UnlistedBadge />
      </Show>
      <Show when={dts()}>
        <span class="pw-install__plugin-supports">supports {dts()}</span>
      </Show>
    </li>
  );
}

export function SourceLine(props: {
  importUrl: string | undefined;
}): JSX.Element {
  const { headsFor } = useActions();
  const heads = () => headsFor(props.importUrl);
  const pinned = () => pinnedModuleUrl(props.importUrl!, heads());
  return (
    <Show
      when={props.importUrl}
      fallback={<span class="pw-source__none">no import url</span>}
    >
      <div class="pw-source__lines">
        <Copyable
          value={bareModuleUrl(props.importUrl!)}
          class="pw-source__url"
          title="importUrl — click to copy"
        />
        <Show when={pinned()}>
          <Copyable
            value={pinned()!}
            label={`heads ${heads()
              .map((h) => h.slice(0, 7))
              .join(" ")}`}
            class="pw-source__heads"
            title="Copy URL pinned to these heads"
          />
        </Show>
      </div>
    </Show>
  );
}

// Which per-source actions apply: automerge sources can be opened; anything
// installed in the viewed doc can be deleted.
export const hasActions = (importUrl: string | undefined, origin: Origin) =>
  isAutomergeUrl(importUrl) || origin === "installed";

/** The right-aligned action group: open (automerge) + delete (installed). */
export function SourceActions(props: {
  importUrl: string | undefined;
  origin: Origin;
}): JSX.Element {
  const { openDoc, uninstall } = useActions();
  return (
    <Show when={hasActions(props.importUrl, props.origin)}>
      <div class="pw-actions">
        <Show when={isAutomergeUrl(props.importUrl)}>
          <button
            class="pw-actions__btn"
            onClick={() => openDoc(props.importUrl!)}
          >
            open
          </button>
        </Show>
        <Show when={props.origin === "installed"}>
          <button
            class="pw-actions__btn pw-actions__btn--danger"
            title="Remove this module from the settings doc you're viewing"
            onClick={() => uninstall(props.importUrl)}
          >
            delete
          </button>
        </Show>
      </div>
    </Show>
  );
}
