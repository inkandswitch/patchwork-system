import { For, Show } from "solid-js";
import { useDocHandle } from "solid-automerge";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { SyncIndicator } from "./SyncIndicator";
import "./styles.css";

/**
 * A `system-tray` component that shows the sync state of every currently
 * selected document in one place. It reads the live selection from the
 * ancestor `SelectedDocProvider` (`patchwork:selected-doc`) and renders one
 * `SyncIndicator` per selected doc.
 *
 * Because the list is a reactive `<For>`, a doc leaving the selection disposes
 * its `SyncIndicator`, whose `onCleanup` unsubscribes it from the worker — so
 * we only ever hold sync-state subscriptions for the docs on screen right now.
 */
export function SyncTray(props: { element: HTMLElement }) {
  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );

  return (
    <Show when={selectedDocUrls().length}>
      <div class="sync-tray">
        <For each={selectedDocUrls()}>{(url) => <SyncTrayItem url={url} />}</For>
      </div>
    </Show>
  );
}

/** Resolve one selected doc url to a handle and show its indicator. */
function SyncTrayItem(props: { url: AutomergeUrl }) {
  const handle = useDocHandle<unknown>(() => props.url);
  return (
    <Show when={handle()}>
      {(h) => <SyncIndicator handle={h() as DocHandle<unknown>} />}
    </Show>
  );
}
