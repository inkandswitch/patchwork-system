import * as A from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { registerUndoProviderElement } from "@inkandswitch/patchwork-undo";
import { afterEach, expect, test, vi } from "vitest";

import { useUndo, useUndoStatus } from "../src/index.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = "";
});

function render(element: ReactElement, container: HTMLElement) {
  const root = createRoot(container);
  act(() => root.render(element));
  cleanups.push(() => act(() => root.unmount()));
}

test("useUndo: a tool's undo state and commands", () => {
  const handle = new Repo().create({ t: "" }) as DocHandle<{ t: string }>;
  const el = document.createElement("div");
  document.body.append(el);
  let seen: ReturnType<typeof useUndo> | undefined;
  function Tool() {
    seen = useUndo(el, handle);
    return null;
  }
  render(createElement(Tool), el);
  expect(seen?.canUndo).toBe(false);
  act(() => handle.change((d) => A.splice(d, ["t"], 0, 0, "x")));
  expect(seen?.canUndo).toBe(true);
  act(() => void seen!.binding.undo());
  expect(handle.doc().t).toBe("");
  expect(seen?.canRedo).toBe(true);
});

test("useUndoStatus: host UI follows the document used last", async () => {
  registerUndoProviderElement();
  const provider = document.createElement("undo-provider");
  document.body.append(provider);
  const toolEl = document.createElement("div");
  const menuEl = document.createElement("nav");
  provider.append(toolEl, menuEl);
  const handle = new Repo().create({ t: "" }) as DocHandle<{ t: string }>;
  let tool: ReturnType<typeof useUndo> | undefined;
  let menu: ReturnType<typeof useUndoStatus> | undefined;
  function Tool() {
    tool = useUndo(toolEl, handle);
    return null;
  }
  function Menu() {
    menu = useUndoStatus(menuEl);
    return null;
  }
  render(createElement(Tool), toolEl);
  render(createElement(Menu), menuEl);
  // Provider messages travel over MessagePorts: let each poll's tick run
  // inside act(), so React applies the updates it brings.
  const until = (check: () => void) =>
    vi.waitFor(async () => {
      await act(() => new Promise((r) => setTimeout(r, 10)));
      check();
    });
  act(() => handle.change((d) => A.splice(d, ["t"], 0, 0, "x")));
  await until(() =>
    expect(menu).toMatchObject({ canUndo: true, url: handle.url })
  );
  act(() => menu!.undo());
  await until(() => expect(handle.doc().t).toBe(""));
  expect(tool?.canRedo).toBe(true);
});
