// @vitest-environment happy-dom
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";

import { registerUndoProviderElement } from "../src/index.js";
// The examples are plain modules for a Patchwork page's import map; here
// Vitest resolves the same bare imports from node_modules.
// @ts-expect-error untyped example module
import { mountCanvas } from "../examples/canvas.js";
// @ts-expect-error untyped example module
import { mountEditMenu } from "../examples/edit-menu.js";
// @ts-expect-error untyped example module
import { mountForm } from "../examples/form.js";
// @ts-expect-error untyped example module
import { plugins } from "../examples/index.js";
// @ts-expect-error untyped example module
import { mountText } from "../examples/text.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const fn of teardowns.splice(0)) fn();
  document.body.innerHTML = "";
});

function host() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function press(target: EventTarget, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("example tools", () => {
  test("the module registers a datatype and a tool for each", () => {
    expect(
      plugins.map((p: { type: string; id: string }) => `${p.type}:${p.id}`)
    ).toEqual([
      "patchwork:datatype:undo-example-text",
      "patchwork:tool:undo-example-text",
      "patchwork:datatype:undo-example-canvas",
      "patchwork:tool:undo-example-canvas",
      "patchwork:datatype:undo-example-form",
      "patchwork:tool:undo-example-form",
    ]);
  });

  test("text: typing, a pause, more typing; Mod+Z twice, Mod+Shift+Z", async () => {
    const handle = new Repo().create({ text: "" }) as DocHandle<{
      text: string;
    }>;
    const el = host();
    teardowns.push(mountText(handle, el));
    const view = EditorView.findFromDOM(
      el.querySelector(".cm-editor") as HTMLElement
    )!;
    const type = (text: string) =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        userEvent: "input.type",
      });
    type("hello");
    await new Promise((r) => setTimeout(r, 600));
    type(" world");
    expect(handle.doc().text).toBe("hello world");

    press(view.contentDOM, "z");
    expect(handle.doc().text).toBe("hello");
    expect(view.state.doc.toString()).toBe("hello");
    press(view.contentDOM, "z");
    expect(view.state.doc.toString()).toBe("");
    press(view.contentDOM, "z", true);
    expect(view.state.doc.toString()).toBe("hello");
    // followUndo put the cursor where the text changed
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(5));
  });

  test("text: a collaborator's change shows and is not undone", () => {
    const handle = new Repo().create({ text: "" }) as DocHandle<{
      text: string;
    }>;
    const el = host();
    teardowns.push(mountText(handle, el));
    const view = EditorView.findFromDOM(
      el.querySelector(".cm-editor") as HTMLElement
    )!;
    view.dispatch({
      changes: { from: 0, insert: "mine" },
      userEvent: "input.type",
    });
    // A collaborator (another actor) appends, and sync brings it in.
    let theirs = A.load<{ text: string }>(A.save(handle.doc()));
    theirs = A.change(theirs, (d) => A.splice(d, ["text"], 4, 0, "!"));
    handle.update((doc) => A.merge(doc, theirs));
    expect(view.state.doc.toString()).toBe("mine!");
    press(view.contentDOM, "z");
    expect(view.state.doc.toString()).toBe("!");
    expect(handle.doc().text).toBe("!");
  });

  test("canvas: the focus is elsewhere, the canvas was used last", () => {
    const handle = new Repo().create({ dots: [] }) as DocHandle<{
      dots: unknown[];
    }>;
    const el = host();
    teardowns.push(mountCanvas(handle, el));
    const canvas = el.querySelector("canvas")!;
    const click = () =>
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          composed: true,
          clientX: 5,
          clientY: 5,
        })
      );
    click();
    click();
    expect(handle.doc().dots).toHaveLength(2);
    expect(press(document.body, "z")).toBe(true);
    expect(handle.doc().dots).toHaveLength(1);
    press(document.body, "z", true);
    expect(handle.doc().dots).toHaveLength(2);
  });

  test("form: the field keeps its own undo, the rest undoes the document", () => {
    const handle = new Repo().create({ title: "", items: [] }) as DocHandle<{
      title: string;
      items: string[];
    }>;
    const el = host();
    teardowns.push(mountForm(handle, el));
    const title = el.querySelector("input")!;
    const add = el.querySelector("button")!;
    title.value = "Groceries";
    title.dispatchEvent(new Event("input"));
    add.click();
    expect(handle.doc().items).toEqual(["item 1"]);
    // In the field: the browser's undo, not ours.
    expect(press(title, "z")).toBe(false);
    expect(handle.doc().items).toEqual(["item 1"]);
    // On the button: the document's undo.
    expect(press(add, "z")).toBe(true);
    expect(handle.doc().items).toEqual([]);
    expect(handle.doc().title).toBe("Groceries");
  });

  test("edit menu: buttons follow the document used last and undo it", async () => {
    registerUndoProviderElement();
    const provider = document.createElement("undo-provider");
    document.body.append(provider);
    const handle = new Repo().create({ dots: [] }) as DocHandle<{
      dots: unknown[];
    }>;
    const toolEl = document.createElement("div");
    const menuEl = document.createElement("nav");
    provider.append(toolEl, menuEl);
    teardowns.push(mountCanvas(handle, toolEl));
    teardowns.push(mountEditMenu(menuEl));
    const [undoButton, redoButton] = menuEl.querySelectorAll("button");
    await vi.waitFor(() => expect(undoButton!.disabled).toBe(true));
    toolEl
      .querySelector("canvas")!
      .dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, composed: true })
      );
    await vi.waitFor(() => expect(undoButton!.disabled).toBe(false));
    undoButton!.click();
    await vi.waitFor(() => expect(handle.doc().dots).toHaveLength(0));
    await vi.waitFor(() => expect(redoButton!.disabled).toBe(false));
    redoButton!.click();
    await vi.waitFor(() => expect(handle.doc().dots).toHaveLength(1));
  });
});
