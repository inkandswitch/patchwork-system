import {
  type AutomergeUrl,
  type Repo,
  type DocHandle,
} from "@automerge/automerge-repo/slim";
import { useDocument } from "solid-automerge";
import type {
  OpenDocumentEventDetail,
  PatchworkViewElement,
} from "@inkandswitch/patchwork-elements";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  Suspense,
} from "solid-js";
import {
  filterMatches,
  setRenaming,
  autoExpandedFolders,
} from "../state.ts";
import { DocumentList } from "./document-list.tsx";
import { watchFolder } from "./auto-expand.ts";
import Item from "./item.tsx";
import { ItemName } from "./name.tsx";
import { LoadingRow } from "./loading-row.tsx";
import { createNew } from "../create-new.tsx";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";
import { Chevron } from "../icons.tsx";
import {
  setDropTarget,
  clearDropTarget,
  copyMode,
  rowSpot,
} from "../dnd/dnd.ts";
import { dropInto } from "../dnd/drop-into.ts";
import { createHoverTimer } from "../lib/hover-timer.ts";
import { setText } from "../lib/text.ts";

export default function Folder(props: {
  url: AutomergeUrl;
  repo: Repo;
  depth?: number;
  removeFromParent(): void;
  open(detail: OpenDocumentEventDetail): void;
  name?: string;
  isSelected(url: AutomergeUrl): boolean;
  visitedFolders?: Set<AutomergeUrl>;
  element: PatchworkViewElement;
  rootFolderHandle: DocHandle<FolderDoc>;
  parentFolderHandle?: DocHandle<FolderDoc>;
  itemIndex?: number;
  filter: string;
  clearFilter(): void;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const [folder, handle] = useDocument<FolderDoc>(() => props.url, props);
  createEffect(() => {
    if (handle.latest) watchFolder(handle.latest);
  });

  // Create a new Set with the current folder URL to prevent circular references
  const nextVisitedFolders = new Set(props.visitedFolders ?? []);
  nextVisitedFolders.add(props.url);

  const depth = () => props.depth ?? 1;
  const depthStyle = () => ({ "--depth": depth() + 1 });
  const folderDepthStyle = () => ({ "--depth": depth() });

  createEffect((last) => {
    if (
      !last &&
      props.filter &&
      filterMatches(props.filter, folder()!?.title ?? props.name)
    ) {
      setExpanded(true);
    }
    return props.filter;
  });

  // Auto-expand when this folder lies on the path to a selected doc. The set is
  // computed from folder data by the panel (see auto-expand.ts), so it reveals
  // deeply nested selections without us having to eagerly mount the subtree:
  // as each ancestor expands it mounts the next level, which re-reads the set.
  createEffect(() => {
    if (autoExpandedFolders().has(props.url)) setExpanded(true);
  });

  // Hold a drag over this folder's row for a second and it opens, so you can
  // drop inside it. It only ever opens: closing a folder you're aiming into
  // would take the target away. Re-arms when the drag leaves.
  const dragOpen = createHoverTimer(1000, () => setExpanded(true));
  onCleanup(dragOpen.stop);

  // Rename shows in two places: the folder's own title (what the row shows)
  // and the parent's docref name (what the filter matches), so change both.
  function rename(name: string) {
    handle()?.change((doc) => setText(doc, ["title"], name));
    const index = props.itemIndex;
    props.parentFolderHandle?.change((parent) => {
      if (index != null && parent.docs[index]?.url === props.url) {
        setText(parent, ["docs", index, "name"], name);
      }
    });
  }

  async function createInside(datatype: Plugin<DatatypeDescription>) {
    const h = handle();
    if (!h) return;
    const freshy = await createNew(props.repo, datatype);
    let newIndex = 0;
    h.change((folder) => {
      folder.docs.push(freshy);
      newIndex = folder.docs.length - 1;
    });
    props.clearFilter();
    setExpanded(true);
    props.open(freshy);
    setRenaming(h.url + "/" + newIndex);
  }

  return (
    <div
      class="document-list-folder"
      role="none"
      data-depth={depth()}
      style={folderDepthStyle()}
      data-dnd-container={props.url}
      ondragover={(event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer!.dropEffect = copyMode() ? "copy" : "move";

        // Over a row, the row has already said where the drop goes (for this
        // folder's own row that's "inside" in its middle). Anywhere else in
        // the folder, the drop goes at the top of it.
        const overRow = (event.target as Element).closest(".document-list-item");
        if (!overRow) {
          setDropTarget(
            rowSpot(
              {
                id: props.url,
                url: props.url,
                parentUrl: props.parentFolderHandle?.url ?? props.url,
                index: props.itemIndex ?? 0,
              },
              "inside"
            )
          );
        }
        if (overRow?.getAttribute("data-dnd-item") === props.url && !expanded()) {
          dragOpen.start();
        }
      }}
      ondragleave={(event: DragEvent) => {
        const related = event.relatedTarget as Element;
        if (!related || !(event.currentTarget as Element).contains(related)) {
          dragOpen.stop();
          clearDropTarget();
        }
      }}
      ondrop={(event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        dragOpen.stop();
        dropInto(event, {
          repo: props.repo,
          rootFolderHandle: props.rootFolderHandle,
          element: props.element,
          expand: () => setExpanded(true),
        });
      }}
    >
      <Item
        aria-label={folder()?.title ?? props.name ?? ""}
        startRenaming={() => {
          setRenaming(props.url);
        }}
        remove={props.removeFromParent}
        id={props.url}
        url={props.url}
        name={folder()?.title ?? props.name ?? ""}
        pressed={props.isSelected(props.url)}
        type="folder"
        element={props.element}
        repo={props.repo}
        rootFolderHandle={props.rootFolderHandle}
        parentFolderHandle={props.parentFolderHandle}
        itemIndex={props.itemIndex}
        isExpanded={expanded()}
        onToggleExpand={() => setExpanded((yn) => !yn)}
        expand={() => setExpanded(true)}
        createInside={createInside}
        openWith={(toolId) => {
          props.open({
            url: props.url,
            toolId,
            title: folder()?.title ?? props.name,
            type: "folder",
          });
        }}
      >
        {/* not a button: it sits inside the row, and the row is what you
            focus. the row's aria-expanded and Left/Right do its job for
            keyboards and screen readers. */}
        <span
          aria-hidden="true"
          class="document-list-folder__toggle"
          on:click={(event: MouseEvent) => {
            event.stopImmediatePropagation();
            setExpanded((yn) => !yn);
          }}
        >
          <Show when={expanded()} fallback={<Chevron />}>
            <Chevron style={{ rotate: "90deg" }} />
          </Show>
        </span>
        <ItemName
          name={folder()?.title ?? props.name}
          id={props.url}
          rename={rename}
        />
      </Item>

      <div
        role="group"
        class="document-list-folder__contents"
        classList={{ "document-list-folder__contents--hidden": !expanded() && !props.filter }}
        data-depth={depth()}
        style={depthStyle()}
      >
        {/* Only mount (and thus load) children when the folder is open or a
            filter is active. Otherwise a collapsed folder would recursively
            find() its entire subtree on mount, loading the whole tree at once
            and making the folder appear to suspend on its descendants rather
            than just its own handle. */}
        <Show when={expanded() || !!props.filter}>
          <Suspense fallback={<LoadingRow depth={depth() + 1} />}>
            <DocumentList
              docs={folder()?.docs}
              repo={props.repo}
              depth={depth() + 1}
              handle={handle.latest!}
              open={props.open}
              isSelected={props.isSelected}
              visitedFolders={nextVisitedFolders}
              element={props.element}
              rootFolderHandle={props.rootFolderHandle}
              filter={props.filter}
              clearFilter={props.clearFilter}
            />
          </Suspense>
        </Show>
      </div>
    </div>
  );
}
