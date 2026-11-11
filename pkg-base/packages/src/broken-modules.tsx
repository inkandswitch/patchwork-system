// A red box per module in your package list that failed to import: what the
// package is (from its package.json), what it says it has, and the error.

import { For, Show, type JSX } from "solid-js";
import { Copyable, DeclaredPluginRow, SourceActions } from "./bits.tsx";
import type { BrokenModule } from "./use-broken-modules.ts";
import type { PkgInfo } from "./pkg-meta.ts";

export function BrokenModules(props: {
  modules: BrokenModule[];
  infoFor: (url: string) => PkgInfo | undefined;
}): JSX.Element {
  return (
    <div class="pw-broken">
      <For each={props.modules}>
        {(b) => {
          const meta = () => props.infoFor(b.url)?.meta;
          const declared = () => props.infoFor(b.url)?.plugins;
          return (
            <div class="pw-broken__box" role="alert">
              <div class="pw-broken__head">
                <span class="pw-broken__label">Failed to import</span>
                <Show when={meta()?.title || meta()?.name}>
                  <span class="pw-broken__name">
                    {meta()!.title || meta()!.name}
                  </span>
                  <Show when={meta()?.version}>
                    <span class="pw-card__version">v{meta()!.version}</span>
                  </Show>
                </Show>
                <Copyable
                  value={b.url}
                  class="pw-broken__url"
                  title="module URL — click to copy"
                />
                {/* It's in the list you're viewing, so it's always removable. */}
                <SourceActions importUrl={b.url} origin="installed" />
              </div>
              <Show when={declared() && declared()!.length > 0}>
                <ul class="pw-install__plugins pw-broken__plugins">
                  <For each={declared()!}>
                    {(p) => <DeclaredPluginRow plugin={p} />}
                  </For>
                </ul>
              </Show>
              <pre class="pw-broken__trace">{b.error}</pre>
            </div>
          );
        }}
      </For>
    </div>
  );
}
