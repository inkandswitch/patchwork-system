import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render } from "solid-js/web";
import {
  getRegistry,
  registerPlugins,
  unregisterPlugins,
} from "@inkandswitch/patchwork-plugins";
import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import CreateNew from "./create-new.tsx";
import { NewDocPlaceholder } from "./create-new-menu.tsx";
import { ItemMenu } from "./document-list/item-menu.tsx";
import { menuTarget, setMenuTarget, type MenuTarget } from "./state.ts";

const createDocOfDatatype2 = vi.fn();
vi.mock("@inkandswitch/patchwork-plugins", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@inkandswitch/patchwork-plugins")>();
  return {
    ...actual,
    createDocOfDatatype2: (...args: unknown[]) => createDocOfDatatype2(...args),
  };
});

const FAKE_URL = "automerge:3tmVsDzywTYecevUsD21YABfXKon" as AutomergeUrl;
const DOC_URL = "automerge:4MCbKQoMiEnGXchaHRH3e7kxWXVs" as AutomergeUrl;
const IMPORT_URL = "test://menus";

beforeAll(async () => {
  registerPlugins(
    [
      {
        type: "patchwork:datatype",
        id: "zed",
        name: "Zed",
        icon: "Z",
        load: async () => ({ init() {}, getTitle: () => "Untitled Zed" }),
      },
      {
        type: "patchwork:datatype",
        id: "md",
        name: "Markdown",
        icon: "M",
        load: async () => ({ init() {}, getTitle: () => "Untitled Markdown" }),
      },
      {
        type: "patchwork:datatype",
        id: "secret",
        name: "Secret",
        icon: "S",
        unlisted: true,
        load: async () => ({ init() {}, getTitle: () => "" }),
      },
      {
        type: "patchwork:tool",
        id: "editor",
        name: "Editor",
        icon: "E",
        supportedDatatypes: ["md"],
        load: async () => () => {},
      },
      {
        type: "patchwork:tool",
        id: "outline",
        name: "Outline",
        icon: "O",
        supportedDatatypes: ["md"],
        load: async () => () => {},
      },
      {
        type: "patchwork:tool",
        id: "hidden-tool",
        name: "Hidden",
        icon: "H",
        supportedDatatypes: ["md"],
        unlisted: true,
        load: async () => () => {},
      },
    ] as any,
    IMPORT_URL
  );
  for (const id of ["zed", "md", "secret"])
    await getRegistry("patchwork:datatype").load(id);
  for (const id of ["editor", "outline", "hidden-tool"])
    await getRegistry("patchwork:tool").load(id);
});

let disposers: (() => void)[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  createDocOfDatatype2.mockReset();
  createDocOfDatatype2.mockImplementation(async () => ({
    url: FAKE_URL,
    doc: () => ({}),
  }));
});

afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  setMenuTarget(null);
  document.body.innerHTML = "";
});

function mount(fn: () => any) {
  disposers.push(render(fn, container));
}

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 1500
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const menu = () => document.querySelector<HTMLElement>("[role=menu]");
const menus = () => [...document.querySelectorAll<HTMLElement>("[role=menu]")];
const items = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>("[role=menuitem]"),
];
const itemTexts = (root: ParentNode = document) =>
  items(root).map((el) => el.textContent?.trim());
const item = (text: string) => {
  const el = items().find((el) => el.textContent?.trim() === text);
  if (!el)
    throw new Error(`no menu item "${text}" in [${itemTexts().join(", ")}]`);
  return el;
};

const Pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
function pointer(target: EventTarget, type: string) {
  target.dispatchEvent(
    new Pointer(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      button: 0,
      pointerType: "mouse",
    } as any)
  );
}
function pointerDown(target: EventTarget) {
  pointer(target, "pointerdown");
  pointer(target, "mousedown");
  pointer(target, "pointerup");
  pointer(target, "mouseup");
}
function click(el: HTMLElement) {
  pointer(el, "pointerdown");
  pointer(el, "mousedown");
  pointer(el, "pointerup");
  pointer(el, "mouseup");
  el.click();
}
function key(target: EventTarget, key: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
    })
  );
}
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const filterInput = () =>
  document.querySelector<HTMLInputElement>(".create-new-filter__input");

describe("CreateNew", () => {
  const props = () => ({
    repo: {} as any,
    changeFolder: vi.fn((fn: (doc: any) => void) => fn(folder)),
    open: vi.fn(),
    clearFilter: vi.fn(),
  });
  let folder: { docs: any[] };
  beforeEach(() => {
    folder = { docs: [] };
  });

  it("shows only the button until clicked", () => {
    mount(() => <CreateNew {...props()} />);
    expect(container.querySelector(".create-new-button")).toBeTruthy();
    expect(menu()).toBeNull();
  });

  it("opens a menu listing listed datatypes sorted by name, with a filter input", async () => {
    mount(() => <CreateNew {...props()} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    expect(itemTexts()).toEqual(["Markdown", "Zed"]);
    expect(filterInput()).toBeTruthy();
  });

  it("lists a datatype with no name by its id instead of breaking", async () => {
    const importUrl = "test://menus-nameless";
    registerPlugins(
      [
        {
          type: "patchwork:datatype",
          id: "nameless",
          name: undefined,
          icon: "?",
          load: async () => ({ init() {}, getTitle: () => "" }),
        },
      ] as any,
      importUrl
    );
    await getRegistry("patchwork:datatype").load("nameless");
    try {
      mount(() => <CreateNew {...props()} />);
      container.querySelector<HTMLElement>(".create-new-button")!.click();
      await waitFor(menu);
      expect(itemTexts()).toEqual(["Markdown", "nameless", "Zed"]);
    } finally {
      unregisterPlugins(importUrl);
    }
  });

  it("filters datatypes as you type", async () => {
    mount(() => <CreateNew {...props()} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    typeInto(filterInput()!, "ze");
    expect(itemTexts()).toEqual(["Zed"]);
  });

  it("offers to add by url when the query is an automerge url", async () => {
    const p = props();
    mount(() => <CreateNew {...p} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    typeInto(filterInput()!, DOC_URL);
    expect(itemTexts()[0]).toBe("Add by URL");
  });

  it("creates a doc of the picked datatype, adds it to the folder, opens it and closes", async () => {
    const p = props();
    mount(() => <CreateNew {...p} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    click(item("Markdown"));
    await waitFor(() => p.open.mock.calls.length);
    expect(createDocOfDatatype2.mock.calls[0][0].id).toBe("md");
    expect(folder.docs).toEqual([
      { name: "Untitled Markdown", type: "md", url: FAKE_URL },
    ]);
    expect(p.clearFilter).toHaveBeenCalled();
    expect(p.open).toHaveBeenCalledWith({
      name: "Untitled Markdown",
      type: "md",
      url: FAKE_URL,
    });
    await waitFor(() => menu() === null);
  });

  it("picks the highlighted datatype with arrow keys + enter from the filter input", async () => {
    const p = props();
    mount(() => <CreateNew {...p} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    key(filterInput()!, "ArrowDown");
    key(filterInput()!, "Enter");
    await waitFor(() => p.open.mock.calls.length);
    expect(createDocOfDatatype2.mock.calls[0][0].id).toBe("zed");
  });

  it("closes on escape", async () => {
    mount(() => <CreateNew {...props()} />);
    container.querySelector<HTMLElement>(".create-new-button")!.click();
    await waitFor(menu);
    key(filterInput()!, "Escape");
    await waitFor(() => menu() === null);
  });

  it("closes on pointerdown outside, and the click that follows doesn't reopen it", async () => {
    mount(() => <CreateNew {...props()} />);
    const button = container.querySelector<HTMLElement>(".create-new-button")!;
    button.click();
    await waitFor(menu);
    pointerDown(button);
    await waitFor(() => menu() === null);
    button.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();
  });
});

describe("NewDocPlaceholder", () => {
  it("opens immediately and reports the created doc", async () => {
    const onCreate = vi.fn(),
      onDismiss = vi.fn(),
      clearFilter = vi.fn();
    mount(() => (
      <NewDocPlaceholder
        repo={{} as any}
        onCreate={onCreate}
        onDismiss={onDismiss}
        clearFilter={clearFilter}
      />
    ));
    await waitFor(menu);
    expect(itemTexts()).toEqual(["Markdown", "Zed"]);
    click(item("Zed"));
    await waitFor(() => onCreate.mock.calls.length);
    expect(onCreate).toHaveBeenCalledWith({
      name: "Untitled Zed",
      type: "zed",
      url: FAKE_URL,
    });
    expect(clearFilter).toHaveBeenCalled();
  });

  it("reports dismissal when closed", async () => {
    const onDismiss = vi.fn();
    mount(() => (
      <NewDocPlaceholder
        repo={{} as any}
        onCreate={vi.fn()}
        onDismiss={onDismiss}
        clearFilter={vi.fn()}
      />
    ));
    await waitFor(menu);
    key(filterInput()!, "Escape");
    await waitFor(() => onDismiss.mock.calls.length);
  });
});

describe("ItemMenu", () => {
  let row: HTMLElement;
  let target: MenuTarget;
  const rootFolderHandle = { change: vi.fn() } as any;

  beforeEach(() => {
    row = document.createElement("div");
    row.tabIndex = 0;
    container.append(row);
    target = {
      x: 10,
      y: 20,
      element: row,
      id: "row-1",
      url: DOC_URL,
      name: "Notes",
      type: "md",
      openWith: vi.fn(),
      startRenaming: vi.fn(),
      remove: vi.fn(),
      createInside: vi.fn(),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
  });

  const mountMenu = () =>
    mount(() => (
      <ItemMenu
        repo={{} as any}
        rootFolderHandle={rootFolderHandle}
        element={container as any}
      />
    ));

  it("is closed until a row asks for it, then lists the row's actions", async () => {
    mountMenu();
    expect(menu()).toBeNull();
    setMenuTarget(target);
    await waitFor(menu);
    expect(itemTexts()).toEqual([
      "Create",
      "Open with...",
      "Copy",
      "Rename",
      "Remove",
    ]);
  });

  it("omits Create for rows that can't contain docs, and Open with... when nothing opens the type", async () => {
    mountMenu();
    setMenuTarget({ ...target, type: "zed", createInside: undefined });
    await waitFor(menu);
    expect(itemTexts()).toEqual(["Copy", "Rename", "Remove"]);
  });

  it("ignores targets outside its panel", async () => {
    mountMenu();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    setMenuTarget({ ...target, element: elsewhere });
    await new Promise((r) => setTimeout(r, 50));
    expect(menu()).toBeNull();
  });

  it("Rename starts renaming and closes, returning focus to the row", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    click(item("Rename"));
    expect(target.startRenaming).toHaveBeenCalled();
    await waitFor(() => menuTarget() === null);
    expect(document.activeElement).toBe(row);
  });

  it("Remove removes a lone item without confirmation", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    click(item("Remove"));
    expect(target.remove).toHaveBeenCalled();
  });

  it("closes after Remove even when the row is gone by then", async () => {
    mountMenu();
    setMenuTarget({ ...target, remove: () => row.remove() });
    await waitFor(menu);
    click(item("Remove"));
    await waitFor(() => menuTarget() === null);
    await waitFor(() => !menu());
  });

  it("Open with... lists the listed tools for the type and opens with the picked one", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    click(item("Open with..."));
    await waitFor(() => menus().length === 2);
    expect(itemTexts(menus()[1])).toEqual(["Editor", "Outline"]);
    click(item("Outline"));
    expect(target.openWith).toHaveBeenCalledWith("outline");
  });

  it("Copy offers the automerge url, the patchwork url, and per-tool patchwork urls", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    click(item("Copy"));
    await waitFor(() => menus().length === 2);
    expect(itemTexts(menus()[1])).toEqual([
      "Automerge url",
      "Patchwork url",
      "Patchwork url with...",
    ]);
    click(item("Automerge url"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(DOC_URL);
  });

  it("Create lists datatypes and creates inside the row", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    click(item("Create"));
    await waitFor(() => menus().length === 2);
    expect(itemTexts(menus()[1]).sort()).toEqual(["Markdown", "Zed"]);
    click(item("Markdown"));
    expect((target.createInside as any).mock.calls[0][0].id).toBe("md");
  });

  it("closes on escape and on pointerdown outside", async () => {
    mountMenu();
    setMenuTarget(target);
    await waitFor(menu);
    key(menu()!, "Escape");
    await waitFor(() => menuTarget() === null);
    setMenuTarget(target);
    await waitFor(menu);
    pointerDown(document.body);
    await waitFor(() => menuTarget() === null);
  });
});
