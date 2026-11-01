import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { registerUndoProviderElement } from "@inkandswitch/patchwork-undo";
import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";

import { createUndo, undoStatus } from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = "";
});

function root<T>(fn: () => T): T {
  return createRoot((dispose) => {
    cleanups.push(dispose);
    return fn();
  });
}

test("createUndo: a tool's undo state and commands", async () => {
  const handle = new Repo().create({ t: "" }) as DocHandle<{ t: string }>;
  const el = document.createElement("div");
  document.body.append(el);
  const controls = root(() => createUndo(el, () => handle));
  expect(controls.canUndo()).toBe(false);
  handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
  expect(controls.canUndo()).toBe(true);
  controls.undo();
  expect(handle.doc().t).toBe("");
  expect(controls.canRedo()).toBe(true);
});

test("undoStatus: host UI follows the document used last", async () => {
  registerUndoProviderElement();
  const provider = document.createElement("undo-provider");
  document.body.append(provider);
  const toolEl = document.createElement("div");
  const menuEl = document.createElement("nav");
  provider.append(toolEl, menuEl);
  const handle = new Repo().create({ t: "" }) as DocHandle<{ t: string }>;
  root(() => createUndo(toolEl, () => handle));
  const menu = root(() => undoStatus(menuEl));
  handle.change((d) => A.splice(d, ["t"], 0, 0, "x"));
  await vi.waitFor(() =>
    expect(menu.status()).toMatchObject({ canUndo: true, url: handle.url })
  );
  menu.undo();
  await vi.waitFor(() => expect(handle.doc().t).toBe(""));
});
