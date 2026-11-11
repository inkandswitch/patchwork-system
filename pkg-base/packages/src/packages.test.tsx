import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

// The real registries live in the host; here there are none.
vi.mock("@inkandswitch/patchwork-plugins", () => ({
  getAllRegistries: () => new Map(),
}));

vi.mock("./discover-plugins.ts", () => ({
  discoverPlugins: vi.fn(async () => []),
  discoverHttpPlugins: vi.fn(async () => []),
  discoverPackagePlugins: vi.fn(async () => []),
}));

import { Packages } from "./packages.tsx";
import type { ToolHandle } from "./registry.ts";

function fakeHandle(): ToolHandle {
  const doc = { modules: [] as string[] };
  return {
    url: "automerge:viewedviewedviewed1",
    doc: () => doc,
    change: (fn) => fn(doc),
    on() {},
    off() {},
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount() {
  const element = document.createElement("div");
  document.body.append(element);
  dispose = render(
    () => <Packages handle={fakeHandle()} element={element} />,
    element
  );
  const search = element.querySelector<HTMLInputElement>(".pw-packages__search")!;
  return { element, search };
}

describe("the filter box", () => {
  it("filters when you type a url, and doesn't open the install modal", () => {
    const { element, search } = mount();
    search.value = "https://example.com/tool/";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(element.querySelector(".pw-modal")).toBeNull();
    expect(search.value).toBe("https://example.com/tool/");
  });

  it("opens the install modal when you paste a url", () => {
    const { element, search } = mount();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "  https://example.com/tool/ " },
    });
    search.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    const input = element.querySelector<HTMLInputElement>(".pw-install__input");
    expect(input?.value).toBe("https://example.com/tool/");
    expect(search.value).toBe("");
  });

  it("lets ordinary text paste through", () => {
    const { element, search } = mount();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "comments" },
    });
    search.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(element.querySelector(".pw-modal")).toBeNull();
  });
});
