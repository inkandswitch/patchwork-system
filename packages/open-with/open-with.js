import { getType, packages } from "@inkandswitch/patchwork-filesystem";
import {
  OpenDocumentEvent,
  defaultTool,
  tool,
  toolsForType,
} from "@inkandswitch/patchwork-elements";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { addedBy, groupTools, packageName } from "./group.js";

const STYLE = `
.open-with { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; font-size: 0.85em; }
.open-with input { font: inherit; padding: 0.25rem 0.5rem; border: 1px solid var(--studio-fill-offset-20, #ccc); border-radius: 4px; background: none; color: inherit; }
.open-with ul { list-style: none; margin: 0; padding: 0; }
.open-with li + li { border-top: 1px solid var(--studio-fill-offset-10, #eee); }
.open-with button { all: unset; box-sizing: border-box; display: flex; gap: 0.5rem; align-items: baseline; width: 100%; padding: 0.25rem 0.5rem; border-radius: 2px; cursor: pointer; }
.open-with button:hover { background: var(--studio-fill-offset-10, #f0f0f0); }
.open-with small { opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.open-with .badge { margin-inline-start: auto; opacity: 0.6; }
.open-with details { padding-inline-start: 1rem; }
.open-with summary { cursor: pointer; opacity: 0.6; padding: 0.125rem 0.5rem; }
.open-with .empty { opacity: 0.6; padding: 0 0.5rem; }
.open-with .preview { display: flex; flex-direction: column; min-height: 20rem; border: 1px solid var(--studio-fill-offset-20, #ccc); border-radius: 4px; overflow: hidden; }
.open-with .preview > patchwork-view { flex: 1; }
`;

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((child) => child != null));
  return el;
}

/**
 * A context sidebar listing every tool that opens the selected doc, from the
 * package database. Where several packages bring one tool id, each is listed,
 * and picking one previews the doc with that package's copy here.
 */
export default function openWith(element, repo) {
  const style = h("style", { textContent: STYLE });
  const filter = h("input", { placeholder: "Filter, or type a tool id…" });
  const list = h("ul");
  const preview = h("div");
  const root = h("div", { className: "open-with" }, filter, list, preview);
  element.append(style, root);

  let url;
  let handle;

  const open = (toolId) =>
    url && element.dispatchEvent(new OpenDocumentEvent({ url, toolId }));

  function showPreview(copy) {
    const view = h("patchwork-view");
    view.setAttribute("doc-url", url);
    view.setAttribute("tool-id", copy.id);
    view.setAttribute("package-url", copy.importUrl);
    preview.replaceChildren(
      h(
        "div",
        { className: "preview" },
        h(
          "button",
          { onclick: () => hidePreview() },
          `${copy.name || copy.id}`,
          h("small", {}, packageName(copy.package)),
          h("span", { className: "badge" }, "close")
        ),
        view
      )
    );
  }

  function hidePreview() {
    preview.replaceChildren();
  }

  function render() {
    const doc = handle?.doc();
    const type = doc && getType(doc);
    if (!url) return list.replaceChildren(h("li", { className: "empty" }, "Nothing selected."));
    if (!type) return list.replaceChildren(h("li", { className: "empty" }, "This document has no type."));

    const fallback = defaultTool(doc)?.id;
    const q = filter.value.trim().toLowerCase();
    const groups = groupTools(toolsForType(type), type, tool).filter(
      (group) =>
        !q || group.name.toLowerCase().includes(q) || group.id.toLowerCase().includes(q)
    );

    list.replaceChildren(
      ...groups.map((group) => {
        const row = h(
          "button",
          { onclick: () => open(group.id), title: `Open with ${group.id}` },
          group.name,
          h("small", {}, group.id),
          group.id === fallback ? h("span", { className: "badge" }, "default") : null
        );
        if (group.copies.length < 2) return h("li", {}, row);
        const copies = group.copies.map((copy, i) =>
          h(
            "button",
            {
              onclick: () => showPreview(copy),
              title: `Preview here with ${copy.importUrl}`,
            },
            packageName(copy.package),
            h("small", {}, `${copy.package.version.slice(0, 7)} · ${addedBy(copy.package)}`),
            i === 0 ? h("span", { className: "badge" }, "opens") : null
          )
        );
        return h(
          "li",
          {},
          row,
          h("details", {}, h("summary", {}, `${group.copies.length} packages`), ...copies)
        );
      })
    );
    if (!groups.length) {
      list.replaceChildren(
        h("li", { className: "empty" }, q ? "Press enter to open with that id." : "No tools.")
      );
    }
  }

  filter.addEventListener("input", render);
  filter.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = list.querySelector("button");
    if (first) first.click();
    else if (filter.value.trim()) open(filter.value.trim());
  });

  let epoch = 0;
  async function select(next) {
    if (next === url) return;
    const mine = ++epoch;
    handle?.off("change", render);
    url = next;
    handle = undefined;
    hidePreview();
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
