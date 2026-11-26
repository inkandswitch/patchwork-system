import { getType, packages } from "@inkandswitch/patchwork-filesystem";
import {
  OpenDocumentEvent,
  defaultTool,
  tool,
  toolsForType,
} from "@inkandswitch/patchwork-elements";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { aboutPackage, groupTools, packageName } from "./group.js";

const STYLE = `
.open-with { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; font-size: 0.85em; }
.open-with input { font: inherit; padding: 0.25rem 0.5rem; border: 1px solid var(--studio-fill-offset-20, #ccc); border-radius: 4px; background: none; color: inherit; }
.open-with ul { list-style: none; margin: 0; padding: 0; }
.open-with li { padding: 0.25rem 0; }
.open-with li + li { border-top: 1px solid var(--studio-fill-offset-10, #eee); }
.open-with button { all: unset; box-sizing: border-box; display: flex; gap: 0.5rem; align-items: baseline; padding: 0.25rem 0.5rem; border-radius: 2px; cursor: pointer; }
.open-with button:hover { background: var(--studio-fill-offset-10, #f0f0f0); }
.open-with .tool { width: 100%; font-weight: 500; }
.open-with small, .open-with .from, .open-with summary, .open-with dt { opacity: 0.6; }
.open-with .badge { margin-inline-start: auto; opacity: 0.6; font-weight: normal; }
.open-with .from { padding: 0 0.5rem; }
.open-with summary { cursor: pointer; padding: 0.125rem 0.5rem; }
.open-with .copy { margin: 0.25rem 0 0.25rem 1rem; padding: 0.25rem 0.5rem; border-inline-start: 2px solid var(--studio-fill-offset-20, #ccc); }
.open-with .copy header { display: flex; gap: 0.5rem; align-items: baseline; }
.open-with .copy header button { margin-inline-start: auto; border: 1px solid var(--studio-fill-offset-20, #ccc); }
.open-with dl { display: grid; grid-template-columns: auto 1fr; gap: 0.125rem 0.5rem; margin: 0.25rem 0 0; }
.open-with dd { margin: 0; overflow-wrap: anywhere; }
.open-with .empty { opacity: 0.6; padding: 0 0.5rem; }
`;

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((child) => child != null));
  return el;
}

/**
 * A context sidebar listing every tool that opens the selected doc, from the
 * package database, with the package each comes from. Where several packages
 * bring one tool id, each is listed and can open the doc with its own copy.
 */
export default function openWith(element, repo) {
  const style = h("style", { textContent: STYLE });
  const filter = h("input", { placeholder: "Filter, or type a tool id…" });
  const list = h("ul");
  const root = h("div", { className: "open-with" }, filter, list);
  element.append(style, root);

  let url;
  let handle;
  // Which tools' details are open, so a re-render keeps them open.
  const expanded = new Set();

  const open = (toolId, packageUrl) =>
    url && element.dispatchEvent(new OpenDocumentEvent({ url, toolId, packageUrl }));

  const copyOf = (copy, opens) => {
    const pkg = copy.package;
    return h(
      "div",
      { className: "copy" },
      h(
        "header",
        {},
        h("strong", {}, packageName(pkg)),
        pkg.packageJson?.version ? h("small", {}, `v${pkg.packageJson.version}`) : null,
        opens ? h("small", {}, "opens by id") : null,
        h(
          "button",
          {
            onclick: () => open(copy.id, pkg.key),
            title: `Open with ${copy.id} from ${pkg.key}`,
          },
          "Open"
        )
      ),
      copy.description ? h("p", {}, copy.description) : null,
      h(
        "dl",
        {},
        ...aboutPackage(pkg).flatMap(([label, value]) => [
          h("dt", {}, label),
          h("dd", {}, value),
        ])
      )
    );
  };

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
        const [first] = group.copies;
        const others = group.copies.length - 1;
        const details = h(
          "details",
          { open: expanded.has(group.id) },
          h("summary", {}, others ? `${group.copies.length} packages` : "package"),
          ...group.copies.map((copy, i) => copyOf(copy, others > 0 && i === 0))
        );
        details.addEventListener("toggle", () =>
          details.open ? expanded.add(group.id) : expanded.delete(group.id)
        );
        return h(
          "li",
          {},
          h(
            "button",
            { className: "tool", onclick: () => open(group.id), title: `Open with ${group.id}` },
            group.name,
            h("small", {}, group.id),
            group.id === fallback ? h("span", { className: "badge" }, "default") : null
          ),
          h(
            "div",
            { className: "from" },
            `from ${packageName(first.package)}`,
            first.package.packageJson?.version ? ` v${first.package.packageJson.version}` : "",
            others ? ` and ${others} more` : ""
          ),
          details
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
    const first = list.querySelector("button.tool");
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
