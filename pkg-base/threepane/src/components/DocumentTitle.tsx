import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { useDocument } from "solid-automerge";
import type { RepoProviderElement } from "@inkandswitch/patchwork-providers";
import {
  getType,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import {
  getRegistry,
  isLoadedPlugin,
  type Datatype,
} from "@inkandswitch/patchwork-plugins";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Accessor,
} from "solid-js";

/**
 * The document title, rendered intrinsically by the frame: resolves the doc's
 * datatype and asks it for a title. Kept in the frame so the top bar owns its
 * placement and sizing.
 *
 * Editable: clicking the title swaps in an input. Saving calls the datatype's
 * `setTitle` and also stamps the new title onto the doc's `@patchwork.title`
 * metadata so the name travels with the doc regardless of datatype shape.
 *
 * The repo is resolved from the nearest `<repo-provider>` ancestor rather than
 * passed in, so it picks up the realm-local repo wherever it renders.
 */
export function DocumentTitle(props: {
  docUrl: Accessor<AutomergeUrl | undefined>;
}) {
  let anchor!: HTMLSpanElement;
  const [repo, setRepo] = createSignal<Repo>();
  onMount(() => {
    setRepo(anchor.closest<RepoProviderElement>("repo-provider")?.repo);
  });

  return (
    <Show
      when={repo()}
      fallback={<span class="threepane__title-text" ref={anchor} />}
    >
      {(resolvedRepo) => (
        <DocumentTitleInner docUrl={props.docUrl} repo={resolvedRepo()} />
      )}
    </Show>
  );
}

function DocumentTitleInner(props: {
  docUrl: Accessor<AutomergeUrl | undefined>;
  repo: Repo;
}) {
  const [doc, handle] = useDocument<HasPatchworkMetadata>(
    () => props.docUrl(),
    { repo: props.repo }
  );
  const registry = getRegistry<Datatype>("patchwork:datatype");

  // Datatypes can register/load late; bump a version so the title recomputes.
  const [registryVersion, setRegistryVersion] = createSignal(0);
  onMount(() => {
    const off = registry.on("changed", () => setRegistryVersion((v) => v + 1));
    onCleanup(off);
  });

  const typeId = createMemo(() => {
    const d = doc();
    return d ? getType(d) : undefined;
  });

  // Ensure the datatype module is loaded so getTitle is callable.
  createEffect(() => {
    const id = typeId();
    if (id) void registry.load(id);
  });

  const datatype = createMemo(() => {
    registryVersion();
    const id = typeId();
    if (!id) return undefined;
    const dt = registry.get(id);
    return dt && isLoadedPlugin(dt) ? dt : undefined;
  });

  const title = createMemo(() => {
    const d = doc();
    const dt = datatype();
    if (!d || !dt) return undefined;
    return dt.module.getTitle(d);
  });

  const canEdit = createMemo(
    () => !!handle() && typeof datatype()?.module.setTitle === "function"
  );

  const [editing, setEditing] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  function startEditing() {
    if (!canEdit()) return;
    setEditing(true);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  function commit(save: boolean) {
    if (!editing()) return;
    setEditing(false);
    if (!save) return;
    const next = inputRef?.value.trim();
    if (!next || next === title()) return;
    const h = handle();
    const setTitle = datatype()?.module.setTitle;
    if (!h || !setTitle) return;
    h.change((d) => {
      setTitle(d, next);
      const meta = (d as HasPatchworkMetadata)["@patchwork"];
      if (meta) (meta as { title?: string }).title = next;
    });
  }

  // Dragging the title drags the doc, in the formats the sidebar's document
  // list (and the browser) take: drop it there and it's added as a link.
  function onDragStart(event: DragEvent) {
    const url = props.docUrl();
    const data = event.dataTransfer;
    if (!url || !data) return;
    const name = title() ?? "Untitled";
    const type = typeId();
    data.effectAllowed = "copyLink";
    data.setData(
      "text/x-patchwork-dnd",
      JSON.stringify({ source: "threepane", items: [{ url, name, type }] })
    );
    data.setData("text/x-patchwork-urls", JSON.stringify([url]));
    data.setData(
      "text/uri-list",
      `${location.origin}${location.pathname}#doc=${url}\r\n`
    );
    data.setData("text/plain", url);
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class="threepane__title-text"
          classList={{ "threepane__title-text--editable": canEdit() }}
          draggable={true}
          onDragStart={onDragStart}
          onClick={startEditing}
          title={canEdit() ? "Rename" : undefined}
        >
          {title() ?? "Untitled"}
        </span>
      }
    >
      <input
        ref={inputRef}
        class="threepane__title-input"
        type="text"
        value={title() ?? ""}
        onBlur={() => commit(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            commit(false);
          }
        }}
      />
    </Show>
  );
}
