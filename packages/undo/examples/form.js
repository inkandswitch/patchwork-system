// A form tool: a title field and a list with an add button. The field keeps
// the browser's own undo of its text while it has focus; everywhere else in
// the tool, Cmd/Ctrl+Z undoes the document.
import * as A from "@automerge/automerge/slim";
import { undoFor } from "@inkandswitch/patchwork-undo";

export function mountForm(handle, element) {
  const undo = undoFor(element, handle);

  const title = document.createElement("input");
  title.className = "undo-example-title";
  title.oninput = () =>
    handle.change((doc) => A.updateText(doc, ["title"], title.value));
  // Leaving the field ends its step.
  title.onblur = () => undo.checkpoint();

  const items = document.createElement("ul");
  items.className = "undo-example-items";
  const add = document.createElement("button");
  add.className = "undo-example-add";
  add.textContent = "add";
  add.onclick = () => {
    handle.change((doc) => {
      doc.items ??= [];
      doc.items.push(`item ${doc.items.length + 1}`);
    });
    undo.checkpoint();
  };

  const render = () => {
    const doc = handle.doc();
    if (document.activeElement !== title) title.value = doc.title ?? "";
    items.replaceChildren(
      ...(doc.items ?? []).map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      })
    );
  };
  handle.on("change", render);
  render();
  element.append(title, items, add);

  return () => {
    handle.off("change", render);
    undo.dispose();
    title.remove();
    items.remove();
    add.remove();
  };
}

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "undo-example-form",
    name: "Undo example: form",
    async load() {
      return {
        init: (doc) => {
          doc.title = "";
          doc.items = [];
        },
        getTitle: (doc) => doc.title || "Form",
      };
    },
  },
  {
    type: "patchwork:tool",
    id: "undo-example-form",
    name: "Form (undo example)",
    supportedDatatypes: ["undo-example-form"],
    async load() {
      return (handle, element) => mountForm(handle, element);
    },
  },
];
