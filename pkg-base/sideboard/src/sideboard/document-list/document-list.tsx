import {
  deleteAt,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type {
  OpenDocumentEventDetail,
  PatchworkViewElement,
} from "@inkandswitch/patchwork-elements";
import type {
  DocLink,
  FolderDoc,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import { getRegistry, isLoadedPlugin, type Datatype } from "@inkandswitch/patchwork-plugins";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
  untrack,
} from "solid-js";
import {
  filterMatches,
  setRenaming,
  pendingNewDoc,
  setPendingNewDoc,
} from "../state.ts";
import { asString, setText } from "../lib/text.ts";
import { markMounted } from "./auto-expand.ts";
import Folder from "./folder.tsx";
import Item from "./item.tsx";
import { ItemName } from "./name.tsx";
import { LoadingRow } from "./loading-row.tsx";

const NewDocPlaceholder = lazy(() =>
  import("../create-new-menu.tsx").then((m) => ({
    default: m.NewDocPlaceholder,
  }))
);

export interface DocumentListProps {
  handle: DocHandle<FolderDoc>;
  docs?: DocLink[];
  depth: number;
  repo: Repo;
  open(detail: OpenDocumentEventDetail): void;
  isSelected(url: AutomergeUrl): boolean;
  visitedFolders?: Set<AutomergeUrl>;
  element: PatchworkViewElement;
  rootFolderHandle: DocHandle<FolderDoc>;
  filter: string;
  clearFilter(): void;
}

// Rows mounted per frame-budget slice while a big folder streams in.
const CHUNK = 40;
const FRAME_BUDGET_MS = 8;

export function DocumentList(props: DocumentListProps) {
  const visitedFolders = props.visitedFolders ?? new Set<AutomergeUrl>();

  // Mount a long list incrementally: the first chunk paints right away, and
  // each animation frame mounts as many more chunks as fit in its budget, so a
  // folder with thousands of entries never freezes the page. Rows keep their
  // identity across slices (automerge preserves it for untouched objects), so
  // For doesn't re-create the ones already on screen.
  const [limit, setLimit] = createSignal(CHUNK);
  createEffect(() => {
    const total = props.docs?.length ?? 0;
    if (untrack(limit) >= total) return;
    let frame = requestAnimationFrame(function more() {
      const start = performance.now();
      let n = untrack(limit);
      do setLimit((n += CHUNK));
      while (n < total && performance.now() - start < FRAME_BUDGET_MS);
      if (n < total) frame = requestAnimationFrame(more);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const docs = createMemo(() => {
    const all = props.docs ?? [];
    return all.length > limit() ? all.slice(0, limit()) : all;
  });

  function removeItem(index: number) {
    props.handle.change((folder) => deleteAt(folder.docs, index));
  }

  // True when a "new document" drag/click targeted this folder's list.
  const pendingHere = () =>
    !!props.handle && pendingNewDoc()?.containerUrl === props.handle.url;

  // Commit the pending placeholder: insert the freshly created doc at the drop
  // index, open it, and drop straight into rename mode.
  const commitPending = (docLink: DocLink) => {
    const target = pendingNewDoc();
    if (!target) return;
    const index = target.index;
    setPendingNewDoc(null);
    props.handle.change((folder) => folder.docs.splice(index, 0, docLink));
    props.open(docLink);
    setRenaming(props.handle.url + "/" + index);
  };

  const placeholder = () => (
    <div class="document-list__item document-list__item--visible">
      <NewDocPlaceholder
        repo={props.repo}
        onCreate={commitPending}
        onDismiss={() => setPendingNewDoc(null)}
        clearFilter={props.clearFilter}
      />
    </div>
  );

  return (
    <>
      <For each={docs()}>
        {(doc, index) => {
          const visible = () =>
            !props.filter.length || filterMatches(props.filter, doc.name);
          const remove = () => removeItem(index());
          const relid = () => props.handle.url + "/" + index();
          onCleanup(markMounted(props.element, doc.url));
          const rename = (name: string) => {
            props.handle.change((doc) =>
              setText(doc, ["docs", index(), "name"], name)
            );
            const datatypes = getRegistry<Datatype>("patchwork:datatype");
            props.repo
              .find<Partial<HasPatchworkMetadata>>(doc.url)
              .then(async (handle) => {
                const { "@patchwork": metadata } = handle.doc();

                if (metadata) {
                  const datatype = datatypes.get(metadata.type) as Datatype;

                  if (datatype) {
                    await datatypes.load(datatype.id);
                    const module = (datatype as any).module;
                    if (module.getTitle?.(handle.doc()) === name) return;
                    handle.change((doc) => module.setTitle?.(doc, name));
                  }
                }
              });
          };

          // Sync title from doc content → folder docref + @patchwork.title
          createEffect(() => {
            if (!props.isSelected(doc.url)) return;

            let cancelled = false;
            let removeListener: (() => void) | undefined;

            props.repo
              .find<Partial<HasPatchworkMetadata>>(doc.url)
              .then(async (docHandle) => {
                if (cancelled) return;

                const datatypes = getRegistry<Datatype>("patchwork:datatype");

                async function syncTitle() {
                  const docData = docHandle.doc();
                  if (!docData) return;

                  const metadata = (docData as any)["@patchwork"];
                  if (!metadata?.type) return;

                  const datatype = datatypes.get(metadata.type) as Datatype;
                  if (!datatype) return;

                  await datatypes.load(datatype.id);
                  if (cancelled) return;
                  if (!isLoadedPlugin(datatype)) return;

                  const title = datatype.module.getTitle(docData);
                  if (!title) return;

                  // Update folder docref name and @patchwork.title if
                  // different. Compare by value: pushwork stores these as
                  // ImmutableStrings, which never === a plain string, and
                  // an unguarded write would land on every open.
                  const currentFolder = props.handle.doc();
                  const currentName = currentFolder?.docs?.[index()]?.name;
                  if (asString(currentName) !== title) {
                    props.handle.change((folder) =>
                      setText(folder, ["docs", index(), "name"], title)
                    );
                  }
                  if (asString(metadata.title) !== title) {
                    docHandle.change((d: any) =>
                      setText(d, ["@patchwork", "title"], title)
                    );
                  }
                }

                await syncTitle();
                if (cancelled) return;

                const onChange = () => syncTitle();
                docHandle.on("change", onChange);
                removeListener = () => docHandle.off("change", onChange);
              });

            onCleanup(() => {
              cancelled = true;
              removeListener?.();
            });
          });

          return (
            <>
              <Show when={pendingHere() && pendingNewDoc()!.index === index()}>
                {placeholder()}
              </Show>
              <div
                classList={{
                  "document-list__item": true,
                  "document-list__item--visible": visible(),
                  "document-list__item--invisible": !visible(),
                }}
              >
                {/* Per-row boundary: a folder still loading its handle shows a
                    skeleton here without blocking its siblings. */}
                <Suspense fallback={<LoadingRow depth={props.depth} />}>
                <Switch>
                <Match when={doc.type == "folder"}>
                  <Show
                    when={!visitedFolders.has(doc.url)}
                    fallback={
                      <div
                        class="document-list-folder__circular-ref"
                        style={{ "padding-left": `calc(var(--depth) * 1rem)` }}
                      >
                        <span>{doc.name} (i contain myself eventually)</span>
                      </div>
                    }
                  >
                    <Folder
                      url={doc.url}
                      depth={props.depth}
                      repo={props.repo}
                      removeFromParent={remove}
                      parentFolderHandle={props.handle}
                      itemIndex={index()}
                      open={props.open}
                      name={doc.name}
                      isSelected={props.isSelected}
                      visitedFolders={visitedFolders}
                      element={props.element}
                      rootFolderHandle={props.rootFolderHandle}
                      filter={props.filter}
                      clearFilter={props.clearFilter}
                    />
                  </Show>
                </Match>
                <Match when={doc.type != "folder"}>
                  <Item
                    aria-label={doc.name}
                    url={doc.url}
                    name={doc.name}
                    id={relid()}
                    startRenaming={() => setRenaming(relid())}
                    remove={remove}
                    pressed={props.isSelected(doc.url)}
                    type={doc.type}
                    element={props.element}
                    repo={props.repo}
                    rootFolderHandle={props.rootFolderHandle}
                    parentFolderHandle={props.handle}
                    itemIndex={index()}
                    openWith={(toolId) =>
                      props.open({
                        url: doc.url,
                        toolId,
                        title: doc.name,
                        type: doc.type,
                      })
                    }
                  >
                    <ItemName name={doc.name} id={relid()} rename={rename} />
                  </Item>
                </Match>
                </Switch>
                </Suspense>
              </div>
            </>
          );
        }}
      </For>
      <Show
        when={pendingHere() && pendingNewDoc()!.index >= (props.docs?.length ?? 0)}
      >
        {placeholder()}
      </Show>
  </>
  );
}
