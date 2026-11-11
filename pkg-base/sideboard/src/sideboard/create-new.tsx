import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type ChangeFn,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  type DatatypeDescription,
  type Plugin,
  createDocOfDatatype2,
  getRegistry,
  isLoadablePlugin,
  isLoadedPlugin,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, lazy, onCleanup, onMount, Show } from "solid-js";
import { NewDocIcon } from "./icons.tsx";
import type { DocLink, FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { docLinkFromUrl } from "./lib/doc-link.ts";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import {
  NEW_DOC_DND_TYPE,
  setNewDocDragging,
  clearDropTarget,
} from "./dnd/dnd.ts";

export async function createNew(
  repo: Repo,
  datatype: Plugin<DatatypeDescription>
): Promise<DocLink> {
  // registry.load returns a new loaded plugin rather than mutating the one
  // we were handed, so use what it gives back.
  if (isLoadablePlugin(datatype)) {
    const registry = getRegistry("patchwork:datatype");
    datatype = (await registry.load(datatype.id)) ?? datatype;
  }
  if (!isLoadedPlugin(datatype)) {
    throw new Error("plugin not loaded after loading");
  }

  const docHandle = await createDocOfDatatype2(datatype, repo);
  const doc = docHandle.doc();
  const name = datatype.module.getTitle(doc);

  return {
    name,
    type: datatype.id,
    url: docHandle.url,
  };
}

const CreateNewMenu = lazy(() =>
  import("./create-new-menu.tsx").then((m) => ({ default: m.CreateNewMenu }))
);

export interface CreateNewProps {
  repo: Repo;
  changeFolder(fn: ChangeFn<FolderDoc>): void;
  open(detail: OpenDocumentEventDetail): void;
  context?: string;
  /** render as a square, icon-only button (e.g. in the doclist toolbar) */
  square?: boolean;
  /** allow dragging the button onto a folder/item to create a doc there */
  draggable?: boolean;
  clearFilter(): void;
}

export default function CreateNew(props: CreateNewProps) {
  const [open, setOpen] = createSignal(false);

  // The menu is split out to keep it off the initial load, but fetching it on
  // the first click makes that click feel dead. Fetch it once things are idle
  // so it's already there by the time anyone reaches for the button.
  onMount(() => {
    const preload = () => void CreateNewMenu.preload();
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(preload);
      onCleanup(() => cancelIdleCallback(id));
    } else {
      const id = setTimeout(preload, 0);
      onCleanup(() => clearTimeout(id));
    }
  });

  async function selectDatatype(datatype: Plugin<DatatypeDescription>) {
    const freshy = await createNew(props.repo, datatype);
    props.changeFolder((doc) => {
      doc.docs.push(freshy);
    });
    // Clear the filter so the just-created doc is actually visible in the list.
    props.clearFilter();
    props.open(freshy);
    setOpen(false);
  }

  async function handleUrlSubmit(url: string) {
    const trimmed = url.trim();
    if (!isValidAutomergeUrl(trimmed)) return;
    const docLink = await docLinkFromUrl(props.repo, trimmed as AutomergeUrl);
    props.changeFolder((doc) => {
      doc.docs.push(docLink);
    });
    // Clear the filter so the freshly added doc is visible.
    props.clearFilter();
    props.open(docLink);
    setOpen(false);
  }

  // Kobalte's menu trigger opens on pointerdown, which swallows the start of a
  // native drag. So the visible button is a plain draggable <button> that we
  // open the menu from on click; a 0-size aria-hidden trigger overlapping it
  // serves only as the dropdown's anchor.
  //
  // Kobalte's interact-outside listener closes the menu on a capture-phase
  // pointerdown (before our click fires), so a click on the open button closes
  // it. Guarding the click against a just-happened close keeps that click from
  // immediately re-opening it.
  let lastCloseAt = 0;

  function handleDragStart(event: DragEvent) {
    setOpen(false);
    setNewDocDragging(true);
    event.dataTransfer!.setData(NEW_DOC_DND_TYPE, "1");
    // "all" keeps move/copy dropEffects (set by the list's dragover handlers)
    // valid so the drop event actually fires.
    event.dataTransfer!.effectAllowed = "all";

    const preview = document.createElement("div");
    preview.style.cssText = `
      position: absolute;
      top: -1000px;
      background: var(--document-list-primary);
      padding: 0.5rem 0.75rem;
      border-radius: var(--document-list-radius);
      font-family: inherit;
      font-size: 0.9rem;
      pointer-events: none;
      color: var(--document-list-primary-line);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    `;
    preview.textContent = "new doc";
    document.body.appendChild(preview);
    event.dataTransfer!.setDragImage(preview, 10, 10);
    setTimeout(() => preview.remove(), 0);
  }

  let anchor!: HTMLDivElement;

  return (
    <div ref={anchor} class="create-new-button-anchor">
      <button
        type="button"
        class="create-new-button"
        classList={{ "create-new-button--square": props.square }}
        aria-label="create new"
        // in case idle never came: start the fetch as the pointer or focus arrives
        onPointerEnter={() => void CreateNewMenu.preload()}
        onFocus={() => void CreateNewMenu.preload()}
        draggable={props.draggable}
        onClick={() => {
          // skip the click that immediately follows an outside-close
          if (performance.now() - lastCloseAt > 200) setOpen(true);
        }}
        on:dragstart={props.draggable ? handleDragStart : undefined}
        on:dragend={() => {
          setNewDocDragging(false);
          clearDropTarget();
        }}
      >
        <NewDocIcon class="create-new-button__icon" />
        <Show when={!props.square}>
          {" "}
          <span class="create-new-button__text">Create new</span>
        </Show>
      </button>
      <Show when={open()}>
        <CreateNewMenu
          anchor={anchor.getBoundingClientRect()}
          onClose={() => {
            setOpen(false);
            lastCloseAt = performance.now();
          }}
          onPickDatatype={selectDatatype}
          onSubmitUrl={handleUrlSubmit}
        />
      </Show>
    </div>
  );
}
