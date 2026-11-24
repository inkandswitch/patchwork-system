// Writers: a context sidebar tab showing the selected doc's history — which
// tool and which person made each change, what it did, and where in the
// tool's source it came from. A doc written before patchwork stamped changes,
// or by a client that doesn't, shows those changes as unstamped.
import {
  decodeHeads,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  encodeHeads,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { automergeUrlToServiceWorkerUrl, resolvePath } from "@inkandswitch/patchwork-filesystem";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { createSourceMapper } from "./sourcemap.js";
import { renderWriters, type Contact, type ContactOf, type NameOf, type WritersCleanup } from "./view.js";

type Finder = { find(url: string): Promise<DocHandle<unknown>> };

/** `name@version` from the package.json at a package root url, or undefined. */
export async function packageName(repo: Finder, url: string): Promise<string | undefined> {
  const root = await repo.find(url);
  const resolved = await resolvePath(repo as unknown as Repo, root, ["package.json"]);
  if (!resolved) return undefined;
  const text =
    typeof resolved.content === "string" ? resolved.content : new TextDecoder().decode(resolved.content);
  const pkg = JSON.parse(text);
  if (typeof pkg?.name !== "string") return undefined;
  return typeof pkg.version === "string" ? `${pkg.name}@${pkg.version}` : pkg.name;
}

/**
 * Looks each key up once, in the background, and calls `arrived` when an
 * answer comes back. A lookup that fails leaves the key unanswered.
 */
function lookup<T>(load: (key: string) => Promise<T | undefined>, arrived: () => void): (key: string) => T | undefined {
  const found = new Map<string, T | undefined>();
  return (key) => {
    if (found.has(key)) return found.get(key);
    found.set(key, undefined);
    load(key).then(
      (value) => {
        if (value === undefined) return;
        found.set(key, value);
        arrived();
      },
      () => {},
    );
    return undefined;
  };
}

/** A `nameOf` that looks each package root up once, in the background. */
export function createNamer(repo: Finder, arrived: () => void): NameOf {
  return lookup((url) => packageName(repo, url), arrived);
}

/** The name, colour and picture on a contact card doc. */
export async function readContact(repo: Finder, url: string): Promise<Contact | undefined> {
  const doc = (await repo.find(url)).doc() as Record<string, unknown> | undefined;
  if (!doc) return undefined;
  const name = doc.type === "registered" && typeof doc.name === "string" && doc.name ? doc.name : "Anonymous";
  const contact: Contact = { name };
  if (typeof doc.color === "string") contact.color = doc.color;
  if (typeof doc.avatarUrl === "string" && doc.avatarUrl) {
    contact.avatar = doc.avatarUrl.startsWith("automerge:")
      ? automergeUrlToServiceWorkerUrl(doc.avatarUrl as never)
      : doc.avatarUrl;
  }
  return contact;
}

export function createContacts(repo: Finder, arrived: () => void): ContactOf {
  return lookup((url) => readContact(repo, url), arrived);
}

const STYLE = `
.pw-hist {
  --pw-hist-fg: var(--studio-line, #1d1f24);
  --pw-hist-muted: var(--studio-line-offset-40, #6b6f78);
  --pw-hist-faint: var(--studio-fill-offset-10, #f1f2f4);
  --pw-hist-border: var(--studio-fill-offset-20, #dadce1);
  --pw-hist-bg: var(--studio-fill, #fff);
  --pw-hist-added: oklch(0.72 0.15 150 / 0.22);
  --pw-hist-removed: oklch(0.66 0.17 25 / 0.2);
  --pw-hist-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
  color: var(--pw-hist-fg);
  font-size: 0.8125rem;
  line-height: 1.4;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}
.pw-hist *, .pw-hist *::before, .pw-hist *::after { box-sizing: border-box; }
.pw-hist button { font: inherit; color: inherit; }
.pw-hist button:focus-visible { outline: 2px solid var(--studio-secondary, #3b82f6); outline-offset: 1px; }

/* The timeline: one block per session, oldest left, coloured by tool, with
   the person's colour along the bottom. */
.pw-hist__strip {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--pw-hist-bg);
  border-bottom: 1px solid var(--pw-hist-border);
  overflow-x: auto;
  scrollbar-width: thin;
  padding: 0.625rem 0.75rem 0.5rem;
}
.pw-hist__track {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  min-height: 34px;
  background: linear-gradient(var(--pw-hist-border), var(--pw-hist-border)) 0 calc(100% - 8px) / 100% 1px no-repeat;
}
.pw-hist__slot { display: flex; }
.pw-hist__block {
  width: calc(var(--pw-hist-size) * 7px);
  height: calc(10px + var(--pw-hist-size) * 4px);
  border: 0;
  border-radius: 3px 3px 1px 1px;
  padding: 0;
  cursor: pointer;
  background:
    linear-gradient(var(--pw-hist-person), var(--pw-hist-person)) bottom / 100% 3px no-repeat,
    var(--pw-hist-writer);
}
.pw-hist__block:hover { filter: brightness(1.08); }
.pw-hist__block--dim { opacity: 0.25; }
.pw-hist__block--open { box-shadow: 0 0 0 1.5px var(--pw-hist-bg), 0 0 0 3px var(--pw-hist-writer); }
.pw-hist__block--marked { position: relative; }
.pw-hist__block--marked::after {
  content: "";
  position: absolute;
  left: 50%;
  top: -7px;
  translate: -50% 0;
  border: 4px solid transparent;
  border-top-color: var(--pw-hist-fg);
}

.pw-hist__legend { padding: 0.5rem 0.75rem 0.25rem; display: grid; gap: 0.375rem; }
.pw-hist__group { display: grid; grid-template-columns: 3.5rem 1fr; align-items: start; gap: 0.5rem; }
.pw-hist__heading { margin: 0.25rem 0 0; font-size: 0.75rem; font-weight: 500; color: var(--pw-hist-muted); }
.pw-hist__chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.pw-hist__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  max-width: 100%;
  border: 1px solid var(--pw-hist-border);
  background: var(--pw-hist-bg);
  border-radius: 999px;
  padding: 0.125rem 0.5rem 0.125rem 0.3rem;
  cursor: pointer;
}
.pw-hist__chip--active { border-color: var(--pw-hist-writer); background: var(--pw-hist-faint); }
.pw-hist__swatch { width: 0.625rem; height: 0.625rem; border-radius: 2px; background: var(--pw-hist-writer); flex: none; }
.pw-hist__chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-hist__chip-count { color: var(--pw-hist-muted); font-variant-numeric: tabular-nums; }

.pw-hist__avatar {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 50%;
  overflow: hidden;
  background: var(--pw-hist-person);
  color: white;
  font-weight: 600;
}
.pw-hist__avatar img { width: 100%; height: 100%; object-fit: cover; }
.pw-hist__avatar--small { width: 1rem; height: 1rem; font-size: 0.5625rem; }
.pw-hist__avatar--large { width: 1.75rem; height: 1.75rem; font-size: 0.75rem; }

.pw-hist__sessions, .pw-hist__changes, .pw-hist__diffs { list-style: none; margin: 0; padding: 0; }
.pw-hist__sessions { padding: 0.25rem 0 0.75rem; }
.pw-hist__session { border-left: 3px solid var(--pw-hist-writer); margin: 0.375rem 0.75rem; border-radius: 2px; }
.pw-hist__session--marked { background: var(--pw-hist-faint); }
.pw-hist__session-head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: start;
  border: 0;
  background: none;
  padding: 0.375rem 0.5rem;
  cursor: pointer;
}
.pw-hist__session-head:hover { background: var(--pw-hist-faint); }
.pw-hist__who, .pw-hist__when { display: grid; min-width: 0; }
.pw-hist__person { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-hist__tool { color: var(--pw-hist-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-hist__when { justify-items: end; }
.pw-hist__time, .pw-hist__count { color: var(--pw-hist-muted); font-size: 0.75rem; white-space: nowrap; }
.pw-hist__summary { margin: 0 0.5rem 0.375rem 2.75rem; color: var(--pw-hist-muted); overflow-wrap: anywhere; }

.pw-hist__changes { padding: 0 0.5rem 0.5rem 0.75rem; }
.pw-hist__change { padding: 0.375rem 0 0.375rem 0.5rem; border-top: 1px solid var(--pw-hist-border); }
.pw-hist__change--marked { box-shadow: inset 2px 0 var(--pw-hist-fg); }
.pw-hist__change-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.pw-hist__message { font-weight: 500; flex: 1 1 8rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.pw-hist__where {
  font-family: var(--pw-hist-mono);
  font-size: 0.6875rem;
  color: var(--pw-hist-muted);
  overflow-wrap: anywhere;
}
.pw-hist__diffs { margin-top: 0.25rem; display: grid; gap: 2px; }
.pw-hist__diff { display: grid; gap: 1px; font-size: 0.75rem; }
.pw-hist__path { font-family: var(--pw-hist-mono); font-size: 0.6875rem; color: var(--pw-hist-muted); overflow-wrap: anywhere; }
.pw-hist__values { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem; font-family: var(--pw-hist-mono); }
.pw-hist__before, .pw-hist__after { text-decoration: none; border-radius: 2px; padding: 0 0.2rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.pw-hist__before { background: var(--pw-hist-removed); text-decoration: line-through; text-decoration-color: oklch(0.6 0.17 25 / 0.6); }
.pw-hist__after { background: var(--pw-hist-added); }
.pw-hist__arrow, .pw-hist__note { color: var(--pw-hist-muted); }
.pw-hist__diff--note { color: var(--pw-hist-muted); font-style: italic; }
.pw-hist__open {
  margin-top: 0.375rem;
  border: 1px solid var(--pw-hist-border);
  background: none;
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.pw-hist__open:hover { background: var(--pw-hist-faint); }
.pw-hist__more {
  display: block;
  margin: 0 auto 1rem;
  border: 1px solid var(--pw-hist-border);
  background: none;
  border-radius: 4px;
  padding: 0.25rem 0.75rem;
  cursor: pointer;
}
.pw-hist__empty, .pw-hist__end { color: var(--pw-hist-muted); margin: 1rem 0.75rem; }
`;

/** The context-tool component: follows the selected doc. */
export function Writers(element: HTMLElement & { repo: Repo }, repo: Repo = element.repo): () => void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const container = document.createElement("div");
  container.className = "pw-hist";
  element.append(style, container);

  /** The live url last shown; undefined before the first show, so that one always draws. */
  let shown: string | null | undefined;
  let stop: WritersCleanup | null = null;
  let token = 0;
  let heads: string[] | null = null;
  const finder = repo as unknown as Finder;
  const redraw = () => stop?.redraw();
  const nameOf = createNamer(finder, redraw);
  const contactOf = createContacts(finder, redraw);
  const originOf = createSourceMapper(repo, redraw);

  const empty = (text: string) => {
    const p = document.createElement("p");
    p.className = "pw-hist__empty";
    p.textContent = text;
    container.replaceChildren(p);
  };

  async function show(url: unknown) {
    // The live doc, not a view at the selection's heads: its whole history,
    // with the version being viewed marked on it.
    let live: string | null = null;
    heads = null;
    if (typeof url === "string") {
      try {
        const parsed = parseAutomergeUrl(url as never);
        live = stringifyAutomergeUrl({ documentId: parsed.documentId });
        heads = parsed.heads ? decodeHeads(parsed.heads as UrlHeads) : null;
      } catch {
        live = url.split("#")[0]!;
      }
    }
    if (live === shown) {
      stop?.mark(heads);
      return;
    }
    shown = live;
    const mine = ++token;
    stop?.();
    stop = null;
    if (!live) return empty("Select a document to see who changed it.");
    empty("Loading…");
    let handle: DocHandle<unknown>;
    try {
      handle = await repo.find(live as never);
    } catch {
      if (mine === token) empty("This document couldn't be loaded.");
      return;
    }
    if (mine !== token) return;
    const documentId = handle.documentId;
    stop = renderWriters(container, handle, {
      nameOf,
      contactOf,
      originOf,
      open: (hash) => {
        element.dispatchEvent(
          new CustomEvent("patchwork:open-document", {
            detail: { url: stringifyAutomergeUrl({ documentId, heads: encodeHeads([hash]) }) },
            bubbles: true,
            composed: true,
          }),
        );
      },
    });
    if (heads) stop.mark(heads);
  }

  void show(null);
  const unsubscribe = subscribe<string[]>(element, { type: "patchwork:selected-doc" }, (urls) => {
    void show(Array.isArray(urls) ? urls[0] : null);
  });

  return () => {
    token++;
    unsubscribe();
    stop?.();
    container.remove();
    style.remove();
  };
}

export const WRITERS_COMPONENT_ID = "provenance";

/** Register with the plugin registry; core does this at setup, so it's in every shell. */
export const plugins = [
  {
    type: "patchwork:component" as const,
    id: WRITERS_COMPONENT_ID,
    tags: ["context-tool"],
    name: "Writers",
    icon: "Fingerprint",
    async load() {
      return Writers;
    },
  },
];
