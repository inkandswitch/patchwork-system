// @vitest-environment happy-dom
import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { OverlayHandle } from "@inkandswitch/patchwork-providers";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  registerUndoProviderElement,
  undoFor,
  watchUndo,
  type Undo,
  type UndoStatus,
} from "../src/index.js";

const bindings: Undo[] = [];
afterEach(() => {
  for (const b of bindings.splice(0)) b.dispose();
  document.body.innerHTML = "";
});

function bind(
  element: HTMLElement | null,
  handle: DocHandle<any>,
  options = {}
) {
  const undo = undoFor(element, handle, { groupDelayMs: 0, ...options });
  bindings.push(undo);
  return undo;
}

function element(tag = "div", parent: HTMLElement = document.body) {
  const el = document.createElement(tag);
  parent.append(el);
  return el;
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: k,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

const repo = () => new Repo();

describe("undoFor", () => {
  test("tools on one document share one history", () => {
    const handle = repo().create({ t: "" });
    const a = bind(element(), handle);
    const b = bind(element(), handle);
    expect(a.history).toBe(b.history);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    b.undo();
    expect(handle.doc().t).toBe("");
    expect(a.canRedo).toBe(true);
  });

  test("subscribe reports canUndo and canRedo", () => {
    const handle = repo().create({ t: "" });
    const undo = bind(null, handle);
    const states: unknown[] = [];
    undo.subscribe((s) => states.push(s));
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    undo.undo();
    expect(states).toEqual([
      { canUndo: false, canRedo: false },
      { canUndo: true, canRedo: false },
      { canUndo: false, canRedo: true },
    ]);
  });

  test("a sub-handle resolves to its root", () => {
    const r = repo();
    const handle = r.create({ m: { t: "" } });
    const sub = handle.sub("m");
    const undo = bind(null, sub, { repo: r });
    expect(undo.history.handle).toBe(handle);
  });

  test("a draft swap moves the binding to the new backing and resets it", () => {
    const r = repo();
    const base = r.create({ t: "" });
    const draft = r.create({ t: "" });
    const overlay = new OverlayHandle({
      presentedUrl: base.url,
      backing: base,
    }) as unknown as DocHandle<{ t: string }>;
    const undo = bind(null, overlay);
    expect(undo.history.handle).toBe(base);
    overlay.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    expect(undo.canUndo).toBe(true);
    (overlay as unknown as OverlayHandle<unknown>).swapBackingDocHandle(
      draft as never
    );
    expect(undo.history.handle).toBe(draft);
    expect(undo.canUndo).toBe(false);
  });

  test("the history is released with its last binding", () => {
    const handle = repo().create({ t: "" });
    const a = bind(null, handle);
    const history = a.history;
    const b = bind(null, handle);
    a.dispose();
    expect(b.history).toBe(history);
    b.dispose();
    expect(bind(null, handle).history).not.toBe(history);
  });
});

describe("keys and focus", () => {
  test("Mod+Z undoes and Mod+Shift+Z and Mod+Y redo in the target's document", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    const inner = element("span", el);
    bind(el, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    expect(key(inner, "z").defaultPrevented).toBe(true);
    expect(handle.doc().t).toBe("");
    key(inner, "z", { shiftKey: true });
    expect(handle.doc().t).toBe("x");
    key(inner, "z");
    key(inner, "y");
    expect(handle.doc().t).toBe("x");
  });

  test("the innermost registered element wins", () => {
    const outer = repo().create({ t: "" });
    const inner = repo().create({ t: "" });
    const a = element();
    const b = element("div", a);
    bind(a, outer);
    bind(b, inner);
    outer.change((d) => A.splice(d, ["t"], 0, 0, "o"));
    inner.change((d) => A.splice(d, ["t"], 0, 0, "i"));
    key(b, "z");
    expect(inner.doc().t).toBe("");
    expect(outer.doc().t).toBe("o");
  });

  test("a canvas without focus gets the keys once used", () => {
    const handle = repo().create({ t: "" });
    const canvas = element("canvas");
    bind(canvas, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    expect(key(document.body, "z").defaultPrevented).toBe(false);
    canvas.dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true })
    );
    expect(key(document.body, "z").defaultPrevented).toBe(true);
    expect(handle.doc().t).toBe("");
  });

  test("using something else ends the fallback", () => {
    const handle = repo().create({ t: "" });
    const canvas = element("canvas");
    const other = element("div");
    bind(canvas, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    canvas.dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true })
    );
    other.dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true })
    );
    expect(key(other, "z").defaultPrevented).toBe(false);
    expect(handle.doc().t).toBe("x");
  });

  test("form fields keep the browser's own undo", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    bind(el, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    for (const tag of ["input", "textarea", "select"]) {
      expect(key(element(tag, el), "z").defaultPrevented).toBe(false);
    }
    const editable = element("div", el);
    editable.contentEditable = "true";
    expect(key(editable, "z").defaultPrevented).toBe(false);
    // An editor marked as writing to the document (as undoBoundaries marks
    // CodeMirror's) hands its keys to the service.
    const marked = element("div", el);
    marked.contentEditable = "true";
    marked.setAttribute("data-patchwork-undo", "");
    expect(key(marked, "z").defaultPrevented).toBe(true);
    expect(handle.doc().t).toBe("");
  });

  test("a marked form field hands its keys to the service", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    el.setAttribute("data-patchwork-undo", "");
    bind(el, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    // A marker on the tool's root doesn't take its fields...
    expect(key(element("input", el), "z").defaultPrevented).toBe(false);
    // ...one on the field itself does.
    const field = element("textarea", el);
    field.setAttribute("data-patchwork-undo", "");
    expect(key(field, "z").defaultPrevented).toBe(true);
    expect(handle.doc().t).toBe("");
  });

  test("an unmarked editor inside a marked one keeps its own undo", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    bind(el, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    // The main editor, an embed in it, and a comment draft editor in that.
    const main = element("div", el);
    main.contentEditable = "true";
    main.setAttribute("data-patchwork-undo", "");
    const embed = element("div", main);
    embed.contentEditable = "false";
    const draft = element("div", embed);
    draft.contentEditable = "true";
    const line = element("span", draft);
    expect(key(line, "z").defaultPrevented).toBe(false);
    expect(handle.doc().t).toBe("x");
    // Inside the embed but outside any editor, the keys are the document's.
    const button = element("button", embed);
    expect(key(button, "z").defaultPrevented).toBe(true);
  });

  test("unbound keys and other modifiers pass through", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    bind(el, handle);
    expect(key(el, "a").defaultPrevented).toBe(false);
    expect(key(el, "z", { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(key(el, "z", { altKey: true }).defaultPrevented).toBe(false);
  });

  test("the browser's history inputs undo too", () => {
    const handle = repo().create({ t: "" });
    const el = element();
    bind(el, handle);
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "historyUndo",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(handle.doc().t).toBe("");
  });
});

describe("the patchwork:undo provider", () => {
  test("host UI sees the state and sends commands", async () => {
    registerUndoProviderElement();
    const provider = element("undo-provider");
    const toolEl = element("div", provider);
    const handle = repo().create({ t: "" });
    bind(toolEl, handle);

    const statuses: UndoStatus[] = [];
    const host = element("nav", provider);
    const watch = watchUndo(host, undefined, (s) => statuses.push(s));
    handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({
        url: handle.url,
        canUndo: true,
        canRedo: false,
      })
    );
    watch.undo();
    await vi.waitFor(() => expect(handle.doc().t).toBe(""));
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ canUndo: false, canRedo: true })
    );
    watch.redo();
    await vi.waitFor(() => expect(handle.doc().t).toBe("x"));
    watch.close();
  });

  test("with a url, only that document's history answers", async () => {
    registerUndoProviderElement();
    const provider = element("undo-provider");
    const a = repo().create({ t: "" });
    const b = repo().create({ t: "" });
    bind(element("div", provider), a);
    bind(element("div", provider), b);
    const statuses: UndoStatus[] = [];
    const watch = watchUndo(element("nav", provider), a.url, (s) =>
      statuses.push(s)
    );
    b.change((d) => A.splice(d, ["t"], 0, 0, "x"));
    a.change((d) => A.splice(d, ["t"], 0, 0, "y"));
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toMatchObject({ url: a.url, canUndo: true })
    );
    watch.undo();
    await vi.waitFor(() => expect(a.doc().t).toBe(""));
    expect(b.doc().t).toBe("x");
    watch.close();
  });
});
