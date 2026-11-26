import { getType, packages } from "@inkandswitch/patchwork-filesystem";
import {
  OpenDocumentEvent,
  defaultTool,
  tool,
  toolsForType,
} from "@inkandswitch/patchwork-elements";
import { subscribe } from "@inkandswitch/patchwork-providers";
import {
  aboutPackage,
  adders,
  atHeads,
  groupTools,
  isAutomerge,
  packageName,
  seenVersions,
  sha256,
  short,
} from "./group.js";

// lattice's trays (lattice's wm/ui/trays.css): soft rounded trays on the
// sheet, and chee.party buttons, a 1px line and a 1px shadow, lifting on hover
const STYLE = `
.open-with {
  --ow-fill: var(--editor-fill, #fff);
  --ow-line: var(--editor-line, #1a1a1a);
  --ow-soft: color-mix(in oklch, var(--ow-fill), var(--ow-line) 7%);
  --ow-edge: color-mix(in oklch, var(--ow-fill), var(--ow-line) 18%);
  --ow-muted: color-mix(in oklch, var(--ow-fill), var(--ow-line) 55%);
  --ow-ease: cubic-bezier(0.23, 1, 0.32, 1);
  display: flex; flex-direction: column; gap: 8px; padding: 8px;
  background: var(--ow-fill); color: var(--ow-line);
  font: 13px var(--editor-family-sans, system-ui, sans-serif);
}
.open-with :is(code, .mono) { font: 11px var(--editor-family-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.open-with .muted { color: var(--ow-muted); }
.open-with .filter {
  padding: 3px; border-radius: 12px; background: var(--ow-soft);
}
.open-with .filter input {
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px;
  border: 0; border-radius: 9px; background: var(--ow-fill); color: inherit; font: inherit; outline: none;
}
.open-with .filter input:focus { box-shadow: 0 0 0 1px var(--ow-line), 1px 1px 0 1px var(--ow-line); }
.open-with .button {
  flex: none; padding: 2px 8px; border: 1px solid var(--ow-line); border-radius: 2px;
  background: var(--ow-fill); box-shadow: 1px 1px 0 var(--ow-line);
  color: inherit; font: inherit; cursor: pointer;
  transition: translate 0.1s var(--ow-ease), box-shadow 0.1s var(--ow-ease);
}
.open-with .button:hover { translate: -1px -1px; box-shadow: 2px 2px 0 var(--ow-line); }
.open-with .button:active { translate: 1px 1px; box-shadow: none; }
.open-with .button[aria-pressed="true"] { background: var(--ow-soft); }
.open-with .button.quiet { border-color: var(--ow-edge); box-shadow: 1px 1px 0 var(--ow-edge); }
.open-with .tools { display: grid; gap: 8px; }
.open-with .tool { display: grid; gap: 4px; padding: 8px; border-radius: 12px; background: var(--ow-soft); }
.open-with .row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.open-with .row > .end { margin-inline-start: auto; }
.open-with .tool h3 { margin: 0; font-size: 1em; font-weight: 600; }
.open-with .badge { padding: 0 6px; border-radius: 9px; background: var(--ow-fill); color: var(--ow-muted); font-size: 11px; }
.open-with summary { cursor: pointer; color: var(--ow-muted); width: fit-content; }
.open-with .package {
  display: grid; gap: 6px; margin-top: 6px; padding: 8px; border-radius: 9px;
  background: var(--ow-fill); box-shadow: 0 0 0 1px var(--ow-edge);
}
.open-with dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
.open-with dt { color: var(--ow-muted); }
.open-with dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.open-with dd .list { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.open-with .versions { display: grid; gap: 2px; max-height: 16rem; overflow: auto; padding: 4px; border-radius: 9px; background: var(--ow-soft); }
.open-with .versions .row { padding: 2px 4px; }
.open-with .empty { color: var(--ow-muted); padding: 0 4px; }
`;

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

const button = (text, onclick, props = {}) =>
  h("button", { type: "button", className: "button", onclick, ...props }, text);

// Where to look up the package lists: the site's watcher, if it put one out.
const listsWith = (entry) => globalThis.patchwork?.packages?.listsWith?.(entry) ?? [];

/**
 * A context sidebar listing every tool that opens the selected doc, from the
 * package database, with the package each comes from: what its package.json
 * says, which package lists have it, and the versions of it there have been.
 */
export default function openWith(element, repo) {
  const style = h("style", { textContent: STYLE });
  const filter = h("input", { placeholder: "Filter, or type a tool id…" });
  const list = h("div", { className: "tools" });
  const root = h("div", { className: "open-with" }, h("div", { className: "filter" }, filter), list);
  element.append(style, root);

  let url;
  let handle;
  // What's open and what's been fetched, kept across re-renders: tool ids
  // whose packages are showing, and by package key, its versions panel.
  const expanded = new Set();
  const panels = new Map();
  const panel = (key) => panels.get(key) ?? panels.set(key, {}).get(key);

  const open = (toolId, packageUrl) =>
    url && element.dispatchEvent(new OpenDocumentEvent({ url, toolId, packageUrl }));

  // A package list's url: an automerge one opens as a doc, an http one is a link.
  const listUrl = (where) =>
    isAutomerge(where)
      ? button(where, () => element.dispatchEvent(new OpenDocumentEvent({ url: where })), {
          className: "button quiet mono",
          title: "Open this package list",
        })
      : h("a", { href: where, target: "_blank", className: "mono" }, where);

  function addedByRows(pkg) {
    return adders(pkg, listsWith).flatMap(({ label, entry, lists }) => [
      h("dt", {}, "added by"),
      h(
        "dd",
        {},
        h(
          "div",
          { className: "list" },
          label,
          ...lists.map((list) => [h("span", { className: "muted" }, list.name), listUrl(list.url)]),
          !lists.length && entry ? h("code", { className: "muted" }, entry) : null
        )
      ),
    ]);
  }

  async function toggleVersions(pkg) {
    const state = panel(pkg.key);
    state.versions = !state.versions;
    render();
    if (state.versions && !state.saved) {
      state.saved = await packages.versions(pkg.key).catch(() => []);
      render();
    }
  }

  async function showAllHeads(pkg) {
    const state = panel(pkg.key);
    state.heads = "loading";
    render();
    try {
      const doc = await repo.find(pkg.key);
      state.heads = doc.history().reverse();
    } catch (error) {
      state.heads = error;
    }
    render();
  }

  async function checkForUpdates(pkg) {
    const state = panel(pkg.key);
    state.check = "checking…";
    render();
    try {
      const at = new URL("package.json", pkg.base ?? pkg.key);
      const response = await fetch(at, { cache: "no-cache" });
      if (!response.ok) throw new Error(`${response.status} from ${at}`);
      const version = await sha256(await response.text());
      state.check = version === pkg.version ? "up to date" : "changed";
    } catch (error) {
      state.check = `couldn't check: ${error.message}`;
    }
    render();
  }

  function versionsPanel(copy, pkg) {
    const state = panel(pkg.key);
    if (!state.versions) return null;
    const seen = seenVersions(pkg, state.saved ?? []);
    const heads = state.heads;
    return h(
      "div",
      { className: "versions" },
      h("div", { className: "muted" }, state.saved ? "seen here" : "seen here (loading saved…)"),
      ...seen.map((version) =>
        h(
          "div",
          { className: "row" },
          h("code", {}, short(version.version)),
          version.packageJson?.version ? h("span", {}, `v${version.packageJson.version}`) : null,
          h("span", { className: "muted" }, new Date(version.addedAt).toLocaleString()),
          version === pkg ? h("span", { className: "badge" }, "current") : null,
          button("Open", () => open(copy.id, version.importUrl), { className: "button end" })
        )
      ),
      Array.isArray(heads)
        ? [
            h("div", { className: "muted" }, `every heads, newest first (${heads.length})`),
            ...heads.map((at, i) =>
              h(
                "div",
                { className: "row" },
                h("span", { className: "muted" }, `${heads.length - i}`),
                h("code", {}, short(at.join("|"))),
                button("Open", () => open(copy.id, atHeads(pkg.key, at)), { className: "button end" })
              )
            ),
          ]
        : heads === "loading"
          ? h("div", { className: "muted" }, "reading its history…")
          : heads instanceof Error
            ? h("div", { className: "muted" }, `couldn't read its history: ${heads.message}`)
            : button("Show every heads", () => showAllHeads(pkg), { className: "button quiet" })
    );
  }

  function packageCard(copy, opensById) {
    const pkg = copy.package;
    const automerge = isAutomerge(pkg.importUrl);
    const state = panel(pkg.key);
    return h(
      "div",
      { className: "package" },
      h(
        "div",
        { className: "row" },
        h("strong", {}, packageName(pkg)),
        pkg.packageJson?.version ? h("span", { className: "muted" }, `v${pkg.packageJson.version}`) : null,
        opensById ? h("span", { className: "badge" }, "opens by id") : null
      ),
      copy.description ? h("div", {}, copy.description) : null,
      h(
        "dl",
        {},
        ...aboutPackage(pkg).flatMap(([label, value]) => [
          h("dt", {}, label),
          h("dd", {}, label === "url" ? h("code", {}, value) : value),
        ]),
        ...addedByRows(pkg)
      ),
      h(
        "div",
        { className: "row" },
        button("Open", () => open(copy.id, pkg.key), {
          title: automerge
            ? `Open with ${copy.id} from this package, following its newest version`
            : `Open with ${copy.id} from this package`,
        }),
        automerge
          ? button("Open version…", () => toggleVersions(pkg), {
              ariaPressed: String(!!state.versions),
            })
          : [
              button("Check for updates", () => checkForUpdates(pkg)),
              state.check ? h("span", { className: "muted" }, state.check) : null,
              state.check === "changed" ? button("Reload page", () => location.reload()) : null,
            ]
      ),
      automerge ? versionsPanel(copy, pkg) : null
    );
  }

  function toolCard(group, fallback) {
    const [first] = group.copies;
    const others = group.copies.length - 1;
    const details = h(
      "details",
      { open: expanded.has(group.id) },
      h("summary", {}, others ? `${group.copies.length} packages` : "package"),
      ...group.copies.map((copy, i) => packageCard(copy, others > 0 && i === 0))
    );
    details.addEventListener("toggle", () =>
      details.open ? expanded.add(group.id) : expanded.delete(group.id)
    );
    return h(
      "section",
      { className: "tool" },
      h(
        "div",
        { className: "row" },
        h("h3", {}, group.name),
        h("code", { className: "muted" }, group.id),
        group.id === fallback ? h("span", { className: "badge" }, "default") : null,
        button("Open", () => open(group.id), { className: "button end", title: `Open with ${group.id}` })
      ),
      h(
        "div",
        { className: "muted" },
        `from ${packageName(first.package)}`,
        first.package.packageJson?.version ? ` v${first.package.packageJson.version}` : "",
        others ? ` and ${others} more` : ""
      ),
      details
    );
  }

  let groups = [];
  function render() {
    const doc = handle?.doc();
    const type = doc && getType(doc);
    if (!url) return list.replaceChildren(h("div", { className: "empty" }, "Nothing selected."));
    if (!type) return list.replaceChildren(h("div", { className: "empty" }, "This document has no type."));

    const q = filter.value.trim().toLowerCase();
    groups = groupTools(toolsForType(type), type, tool).filter(
      (group) =>
        !q || group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q)
    );
    const fallback = defaultTool(doc)?.id;
    list.replaceChildren(
      ...(groups.length
        ? groups.map((group) => toolCard(group, fallback))
        : [h("div", { className: "empty" }, q ? "Press enter to open with that id." : "No tools.")])
    );
  }

  filter.addEventListener("input", render);
  filter.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const typed = filter.value.trim();
    if (groups.length) open(groups[0].id);
    else if (typed) open(typed);
  });

  let epoch = 0;
  async function select(next) {
    if (next === url) return;
    const mine = ++epoch;
    handle?.off("change", render);
    url = next;
    handle = undefined;
    render();
    if (!url) return;
    const found = await repo.find(url).catch(() => undefined);
    if (mine !== epoch) return;
    handle = found;
    handle?.on("change", render);
    render();
  }

  const offs = [
    subscribe(element, { type: "patchwork:selected-doc" }, (urls) => select(urls?.[0])),
    packages.on("added", render),
    packages.on("replaced", render),
    packages.on("removed", render),
  ];
  render();

  return () => {
    epoch++;
    handle?.off("change", render);
    offs.forEach((off) => off());
    root.remove();
    style.remove();
  };
}
