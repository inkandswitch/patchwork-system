// The three ways to look at the registered plugins. Each takes the already
// filtered entries and does its own grouping or sorting.

import { createMemo, For, Show, type JSX } from "solid-js";
import {
  Collapsible,
  Copyable,
  hasActions,
  OriginBadge,
  PluginRow,
  SourceActions,
  SourceLine,
  UnlistedBadge,
} from "./bits.tsx";
import {
  datatypesLabel,
  groupByPackage,
  groupByType,
  sortRows,
  type Enriched,
  type SortKey,
} from "./model.ts";

/** One card per package, with the plugins it registered. */
export function ByPackage(props: { entries: Enriched[] }): JSX.Element {
  const groups = createMemo(() => groupByPackage(props.entries));
  return (
    <ul class="pw-cards">
      <For each={groups()}>
        {(group) => (
          <li class="pw-card" data-origin={group.origin}>
            <header class="pw-card__head">
              <h2 class="pw-card__name">{group.name}</h2>
              <div class="pw-card__badges">
                <Show when={group.meta?.version}>
                  <span class="pw-card__version">v{group.meta!.version}</span>
                </Show>
                <OriginBadge origin={group.origin} />
                <span class="pw-card__count">
                  {group.plugins.length} plugin
                  {group.plugins.length === 1 ? "" : "s"}
                </span>
              </div>
            </header>
            <Show when={group.meta?.name && group.meta?.name !== group.name}>
              <div class="pw-card__pkgname">{group.meta!.name}</div>
            </Show>
            <div class="pw-card__source">
              <SourceLine importUrl={group.importUrl} />
            </div>
            <ul class="pw-plugins">
              <Collapsible
                each={group.plugins}
                render={(plugin) => <PluginRow plugin={plugin} />}
              />
            </ul>
            <Show when={hasActions(group.importUrl, group.origin)}>
              <footer class="pw-card__foot">
                <SourceActions
                  importUrl={group.importUrl}
                  origin={group.origin}
                />
              </footer>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

/** One section per registry, i.e. per plugin type. */
export function ByType(props: { entries: Enriched[] }): JSX.Element {
  const groups = createMemo(() => groupByType(props.entries));
  return (
    <div class="pw-registries">
      <For each={groups()}>
        {(group) => (
          <section class="pw-registry">
            <header class="pw-registry__head">
              <h2 class="pw-registry__name">{group.registry}</h2>
              <span class="pw-registry__count">{group.plugins.length}</span>
            </header>
            <ul class="pw-reglist">
              <Collapsible
                each={group.plugins}
                render={(plugin) => <TypeRow plugin={plugin} />}
              />
            </ul>
          </section>
        )}
      </For>
    </div>
  );
}

function TypeRow(props: { plugin: Enriched }): JSX.Element {
  const dts = () => datatypesLabel(props.plugin.supportedDatatypes);
  return (
    <li class="pw-regitem" data-origin={props.plugin.origin}>
      <div class="pw-regitem__main">
        <span
          class="pw-regitem__name"
          classList={{ "is-unlisted": props.plugin.unlisted }}
        >
          {props.plugin.name}
        </span>
        <Copyable
          value={props.plugin.id}
          class="pw-regitem__id"
          title="Plugin id — click to copy"
        />
        <OriginBadge origin={props.plugin.origin} />
        <Show when={props.plugin.unlisted}>
          <UnlistedBadge />
        </Show>
        <Show when={dts()}>
          <span class="pw-regitem__supports">supports {dts()}</span>
        </Show>
      </div>
      <div class="pw-regitem__source">
        <span class="pw-regitem__pkg">{props.plugin.pkgName}</span>
        <SourceLine importUrl={props.plugin.importUrl} />
        <SourceActions
          importUrl={props.plugin.importUrl}
          origin={props.plugin.origin}
        />
      </div>
    </li>
  );
}

const COLUMNS: [SortKey, string][] = [
  ["name", "Name"],
  ["registry", "Registry"],
  ["id", "Id"],
  ["package", "Package"],
  ["origin", "Origin"],
  ["unlisted", "Unlisted"],
];

/** A flat, sortable table. The sort lives with the caller so it survives view switches. */
export function Table(props: {
  entries: Enriched[];
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
}): JSX.Element {
  const rows = createMemo(() =>
    sortRows(props.entries, props.sortKey, props.sortAsc)
  );
  return (
    <div class="pw-table-wrap">
      <table class="pw-table">
        <thead>
          <tr>
            <For each={COLUMNS}>
              {([key, label]) => (
                <th
                  class="pw-table__th"
                  data-sorted={props.sortKey === key ? "" : undefined}
                  onClick={() => props.onSort(key)}
                >
                  {label}
                  <Show when={props.sortKey === key}>
                    <span class="pw-table__arrow">
                      {props.sortAsc ? "▲" : "▼"}
                    </span>
                  </Show>
                </th>
              )}
            </For>
            <th class="pw-table__th pw-table__th--plain">importUrl</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(e) => (
              <tr class="pw-table__row" data-origin={e.origin}>
                <td
                  class="pw-table__name"
                  classList={{ "is-unlisted": e.unlisted }}
                >
                  {e.name}
                  <Show when={datatypesLabel(e.supportedDatatypes)}>
                    <span class="pw-table__supports">
                      {datatypesLabel(e.supportedDatatypes)}
                    </span>
                  </Show>
                </td>
                <td class="pw-table__reg">{e.registry}</td>
                <td>
                  <Copyable value={e.id} class="pw-table__id" />
                </td>
                <td class="pw-table__pkg">{e.pkgName}</td>
                <td>
                  <OriginBadge origin={e.origin} />
                </td>
                <td class="pw-table__flag">
                  <Show when={e.unlisted}>
                    <span title="Hidden from new-document menus and pickers">
                      ✓
                    </span>
                  </Show>
                </td>
                <td class="pw-table__url">
                  <div class="pw-source">
                    <SourceLine importUrl={e.importUrl} />
                    <SourceActions importUrl={e.importUrl} origin={e.origin} />
                  </div>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
