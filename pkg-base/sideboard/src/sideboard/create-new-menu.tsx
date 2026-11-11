import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, For, Show } from "solid-js";
import type { DocLink } from "@inkandswitch/patchwork-filesystem";
import { docLinkFromUrl } from "./lib/doc-link.ts";
import { useFilteredDatatypes } from "./lib/solid-plugins";
import { Menu, MenuItem, type Anchor } from "./popmenu.tsx";
import { createNew } from "./create-new.tsx";

// a broken plugin may register without a name; show its id rather than
// letting it take the whole menu down
const label = (d: Plugin<DatatypeDescription>) =>
  typeof d.name === "string" ? d.name : String(d.id);

/**
 * The contents of the create-new dropdown: a filter input (also accepts a pasted
 * automerge url) and the list of datatypes. Rendered inside a <DropdownMenu> so
 * it can be reused by the toolbar button and the drag-created placeholder.
 */
function DatatypeMenuContent(props: {
  onPickDatatype(datatype: Plugin<DatatypeDescription>): void;
  onSubmitUrl(url: string): void;
}) {
  const datatypes = useFilteredDatatypes((item) => !item.unlisted);
  const [query, setQuery] = createSignal("");
  const [highlightIndex, setHighlightIndex] = createSignal(0);

  const isUrl = () => isValidAutomergeUrl(query().trim());

  const filteredDatatypes = () => {
    const q = query().toLowerCase();
    const matching = q
      ? datatypes.filter((d) => label(d).toLowerCase().includes(q))
      : datatypes;
    return [...matching].sort((a, b) => label(a).localeCompare(label(b)));
  };

  // total number of selectable items (url item + datatypes)
  const itemCount = () => (isUrl() ? 1 : 0) + filteredDatatypes().length;

  function selectHighlighted() {
    const idx = highlightIndex();
    if (isUrl()) {
      if (idx === 0) {
        props.onSubmitUrl(query());
        return;
      }
      // offset by 1 for the url item
      const datatype = filteredDatatypes()[idx - 1];
      if (datatype) props.onPickDatatype(datatype);
    } else {
      const datatype = filteredDatatypes()[idx];
      if (datatype) props.onPickDatatype(datatype);
    }
  }

  return (
    <>
      <div class="create-new-filter">
        <input
          class="create-new-filter__input"
          placeholder="Filter or paste automerge url…"
          value={query()}
          onInput={(e) => {
            setQuery(e.target.value);
            setHighlightIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              selectHighlighted();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlightIndex((i) => Math.min(i + 1, itemCount() - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlightIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Escape") {
              // let the menu handle escape to close
              return;
            }
            // prevent the menu from handling other keys
            e.stopPropagation();
          }}
          onPaste={(e) => {
            // Pasting an automerge url should *offer* to add it (revealing the
            // "Add by URL" item) rather than silently adding it. Drop the
            // pasted text into the query; isUrl() then shows the button.
            const text = e.clipboardData?.getData("text/plain") ?? "";
            if (isValidAutomergeUrl(text.trim())) {
              e.preventDefault();
              setQuery(text.trim());
              setHighlightIndex(0);
            }
          }}
          ref={(el) => {
            requestAnimationFrame(() => el.focus());
          }}
        />
      </div>
      <Show when={isUrl()}>
        <MenuItem
          classList={{
            "popmenu__item--highlighted": highlightIndex() === 0,
          }}
          onSelect={() => props.onSubmitUrl(query())}
          onPointerMove={() => setHighlightIndex(0)}
        >
          Add by URL
        </MenuItem>
      </Show>
      <For each={filteredDatatypes()}>
        {(datatype, i) => (
          <MenuItem
            classList={{
              "popmenu__item--highlighted":
                highlightIndex() === i() + (isUrl() ? 1 : 0),
            }}
            onSelect={() => props.onPickDatatype(datatype)}
            onPointerMove={() => setHighlightIndex(i() + (isUrl() ? 1 : 0))}
          >
            {label(datatype)}
          </MenuItem>
        )}
      </For>
    </>
  );
}

/**
 * The open create-new dropdown, hanging below `anchor`. Mounted only while open,
 * so the menu code stays out of the document list's initial load.
 */
export function CreateNewMenu(props: {
  anchor: Anchor;
  onClose(): void;
  onPickDatatype(datatype: Plugin<DatatypeDescription>): void;
  onSubmitUrl(url: string): void;
}) {
  return (
    <Menu
      anchor={props.anchor}
      class="popmenu__content create-new-menu__content"
      autofocus={false}
      onClose={props.onClose}
    >
      <DatatypeMenuContent
        onPickDatatype={props.onPickDatatype}
        onSubmitUrl={props.onSubmitUrl}
      />
    </Menu>
  );
}

/**
 * A pending "…new doc…" row inserted at a drag-drop location. Auto-opens the
 * type picker anchored to itself; picking a type (or dismissing) is reported via
 * the callbacks so the owning DocumentList can insert the doc at the right index.
 */
export function NewDocPlaceholder(props: {
  repo: Repo;
  onCreate(docLink: DocLink): void;
  onDismiss(): void;
  clearFilter(): void;
}) {
  let row!: HTMLDivElement;

  async function pickDatatype(datatype: Plugin<DatatypeDescription>) {
    const freshy = await createNew(props.repo, datatype);
    props.clearFilter();
    props.onCreate(freshy);
  }

  async function submitUrl(url: string) {
    const trimmed = url.trim();
    if (!isValidAutomergeUrl(trimmed)) return;
    const docLink = await docLinkFromUrl(props.repo, trimmed as AutomergeUrl);
    props.clearFilter();
    props.onCreate(docLink);
  }

  return (
    <>
      <div ref={row} class="document-list-item document-list-placeholder">
        <span class="document-list-item__name">New document</span>
      </div>
      <Menu
        anchor={row.getBoundingClientRect()}
        class="popmenu__content create-new-menu__content"
        autofocus={false}
        onClose={props.onDismiss}
      >
        <DatatypeMenuContent
          onPickDatatype={pickDatatype}
          onSubmitUrl={submitUrl}
        />
      </Menu>
    </>
  );
}
