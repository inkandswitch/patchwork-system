// Writers: a context sidebar tab showing which package version wrote each
// change to the selected doc. A doc written before patchwork stamped changes,
// or by a client that doesn't, shows those changes as unstamped.
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { resolvePath } from "@inkandswitch/patchwork-filesystem";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { renderWriters, type NameOf, type WritersCleanup } from "./view.js";

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
 * A `nameOf` that looks each package root up once, in the background, and
 * calls `arrived` when a name comes back. A lookup that fails leaves the url
 * unnamed.
 */
export function createNamer(repo: Finder, arrived: () => void): NameOf {
  const names = new Map<string, string | undefined>();
  return (url) => {
    if (names.has(url)) return names.get(url);
    names.set(url, undefined);
    packageName(repo, url).then(
      (name) => {
        if (name === undefined) return;
        names.set(url, name);
        arrived();
      },
      () => {},
    );
    return undefined;
  };
}

const STYLE = `
.pw-writers {
  --pw-writers-fg: var(--studio-line, black);
  --pw-writers-muted: var(--studio-line-offset-40, #666);
  --pw-writers-border: var(--studio-fill-offset-20, #ccc);
  color: var(--pw-writers-fg);
  font-size: 0.8125rem;
  padding: var(--studio-space-sm, 0.75rem);
  overflow: auto;
  height: 100%;
  box-sizing: border-box;
}
.pw-writers__heading {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pw-writers-muted);
  margin: 0 0 0.375rem;
}
.pw-writers__heading:not(:first-child) { margin-top: 1rem; }
.pw-writers__list { list-style: none; margin: 0; padding: 0; }
.pw-writers__writer,
.pw-writers__change {
  padding: 0.375rem 0;
  border-bottom: 1px solid var(--pw-writers-border);
}
.pw-writers__writer {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 0.5rem;
}
.pw-writers__label { font-weight: 500; overflow-wrap: anywhere; }
.pw-writers__count { color: var(--pw-writers-muted); text-align: end; }
.pw-writers__writer .pw-writers__time { grid-column: 1 / -1; }
.pw-writers__time { color: var(--pw-writers-muted); font-size: 0.75rem; }
.pw-writers__change-head { display: flex; justify-content: space-between; gap: 0.5rem; }
.pw-writers__message { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 0.125rem; }
.pw-writers__empty { color: var(--pw-writers-muted); margin: 0; }
`;

/** The context-tool component: follows the selected doc. */
export function Writers(element: HTMLElement & { repo: Repo }, repo: Repo = element.repo): () => void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const container = document.createElement("div");
  container.className = "pw-writers";
  element.append(style, container);

  /** The live url last shown; undefined before the first show, so that one always draws. */
  let shown: string | null | undefined;
  let stop: WritersCleanup | null = null;
  let token = 0;
  const nameOf = createNamer(repo as unknown as Finder, () => stop?.redraw());

  const empty = (text: string) => {
    const p = document.createElement("p");
    p.className = "pw-writers__empty";
    p.textContent = text;
    container.replaceChildren(p);
  };

  async function show(url: unknown) {
    // The live doc, not a view at the selection's heads: its whole history.
    const live = typeof url === "string" ? url.split("#")[0]! : null;
    if (live === shown) return;
    shown = live;
    const mine = ++token;
    stop?.();
    stop = null;
    if (!live) return empty("No document selected.");
    empty("Loading…");
    let handle: DocHandle<unknown>;
    try {
      handle = await repo.find(live as never);
    } catch {
      if (mine === token) empty("This document couldn't be loaded.");
      return;
    }
    if (mine !== token) return;
    stop = renderWriters(container, handle, { nameOf });
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
