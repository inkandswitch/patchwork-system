import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as A from "@automerge/automerge/slim";
import { Repo, initSubduction, type DocHandle } from "@automerge/automerge-repo";
import { personLabel, renderWriters, writerLabel, type ViewOptions, type WritersCleanup } from "../src/index.js";

const KEY_A = "4kQx9TmB";
const KEY_B = "7wZp2RnC";
const ROOT_A = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ#abc";
const ROOT_B = "site@42";
const AUTHOR = "a1b2c3d4e5f60718";
const DEVICE = AUTHOR.repeat(4);
const CONTACT = "automerge:3xH1AZwy53dHX3mqxkdfN875J3HT";

let repo: Repo;
beforeAll(async () => {
  await initSubduction();
  repo = new Repo({});
});
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

let cleanup: WritersCleanup | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/**
 * A doc with records for two writers and one author: an unstamped first
 * change, then two changes from A by the author, then one from B.
 */
function setup(options: Partial<ViewOptions> = {}) {
  const handle: DocHandle<any> = repo.create<any>({
    "@patchwork": {
      type: "test",
      writers: { [KEY_A]: { url: ROOT_A }, [KEY_B]: { url: ROOT_B } },
      authors: { [AUTHOR]: { device: DEVICE, contact: CONTACT } },
    },
    layers: [{ name: "Layer 1" }],
    text: "hello world",
  });
  (A.getBackend(handle.doc()) as any).setAuthor(AUTHOR);
  handle.change((d) => (d.layers[0].name = "Background"), { message: `rename layer\npw:${KEY_A} dist/index.js:412:17` });
  handle.change((d) => A.updateText(d, ["text"], "hello there"), { message: `pw:${KEY_A} dist/index.js:90:3` });
  (A.getBackend(handle.doc()) as any).setAuthor("ffffffffffffffff");
  handle.change((d) => (d.extra = true), { message: `pw:${KEY_B} assets/index.js:1:1` });
  const container = document.createElement("div");
  document.body.append(container);
  cleanup = renderWriters(container, handle, {
    nameOf: (url) => (url === ROOT_A ? "@x/draw@1.2.0" : undefined),
    contactOf: (url) => (url === CONTACT ? { name: "Ada", color: "rebeccapurple" } : undefined),
    ...options,
  });
  return { handle, container };
}

const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((n) => n.textContent!);
const head = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>(".pw-hist__session-head")].find((b) => b.textContent!.includes(text))!;

describe("labels", () => {
  it("names each kind of writer", () => {
    const nameOf = (url: string) => (url === ROOT_A ? "@x/draw@1.2.0" : undefined);
    expect(writerLabel({ url: ROOT_A }, KEY_A, nameOf)).toBe("@x/draw@1.2.0");
    expect(writerLabel({ url: ROOT_A }, KEY_A, () => undefined)).toBe("automerge:2j9knp…");
    expect(writerLabel({ url: "site@42" }, KEY_A, nameOf)).toBe("site (build 42)");
    expect(writerLabel("unrecorded", KEY_A, nameOf)).toBe(`pw:${KEY_A} (no record)`);
    expect(writerLabel(null, null, nameOf)).toBe("Unstamped");
  });

  it("names each kind of person", () => {
    const contactOf = () => ({ name: "Ada" });
    expect(personLabel({ device: DEVICE, contact: CONTACT }, AUTHOR, contactOf)).toBe("Ada");
    expect(personLabel({ device: DEVICE, contact: CONTACT }, AUTHOR, () => undefined)).toBe("Someone");
    expect(personLabel("unrecorded", AUTHOR, contactOf)).toBe("Device a1b2c3d4");
    expect(personLabel(null, null, contactOf)).toBe("No author");
  });
});

describe("renderWriters", () => {
  it("draws a timeline block per session, oldest first", () => {
    const { container } = setup();
    const blocks = [...container.querySelectorAll<HTMLButtonElement>(".pw-hist__block")];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.getAttribute("aria-label")).toContain("Unstamped");
    expect(blocks[1]!.getAttribute("aria-label")).toContain("@x/draw@1.2.0");
    expect(blocks[1]!.getAttribute("aria-label")).toContain("Ada");
    expect(blocks[2]!.getAttribute("aria-label")).toContain("site (build 42)");
  });

  it("lists the tools and the people, with how many changes each made", () => {
    const { container } = setup();
    const chips = [...container.querySelectorAll(".pw-hist__chip")].map(
      (chip) => `${chip.querySelector(".pw-hist__chip-label")!.textContent} ${chip.querySelector(".pw-hist__chip-count")!.textContent}`,
    );
    expect(chips).toContain("@x/draw@1.2.0 2");
    expect(chips).toContain("Ada 2");
    expect(chips).toContain("Device ffffffff 1");
  });

  it("shows a session's person and tool, and opens it to show what each change did", async () => {
    const { container } = setup({
      originOf: (writer, at) =>
        writer === ROOT_A && at === "dist/index.js:412:17" ? { source: "src/Canvas.tsx", line: 88, column: 5 } : undefined,
    });
    const draw = head(container, "@x/draw@1.2.0");
    expect(draw.textContent).toContain("Ada");
    expect(draw.textContent).toContain("2 changes");
    expect(draw.getAttribute("aria-expanded")).toBe("false");
    draw.click();
    await frame();
    const open = head(container, "@x/draw@1.2.0");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const changes = texts(container, ".pw-hist__change");
    const rename = changes.find((c) => c.includes("rename layer"))!;
    expect(rename).toContain("src/Canvas.tsx:88");
    expect(rename).toContain("layers[0].name");
    expect(rename).toContain('"Layer 1"');
    expect(rename).toContain('"Background"');
    const typed = changes.find((c) => c.includes("dist/index.js:90"))!;
    expect(typed).toContain("world");
    expect(typed).toContain("there");
  });

  it("shows only the chosen tool's sessions, and everything again on a second choice", async () => {
    const { container } = setup();
    const site = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".pw-hist__chip")].find((c) => c.textContent!.startsWith("site"))!;
    site().click();
    await frame();
    expect(container.querySelectorAll(".pw-hist__session")).toHaveLength(1);
    expect(container.querySelectorAll(".pw-hist__block--dim")).toHaveLength(2);
    site().click();
    await frame();
    expect(container.querySelectorAll(".pw-hist__session")).toHaveLength(3);
  });

  it("opens the doc at a change", async () => {
    const opened: string[] = [];
    const { handle, container } = setup({ open: (hash) => opened.push(hash) });
    head(container, "site").click();
    await frame();
    container.querySelector<HTMLButtonElement>(".pw-hist__open")!.click();
    expect(opened).toEqual([A.getHeads(handle.doc())[0]]);
  });

  it("marks the version being viewed and opens its session", async () => {
    const { handle, container } = setup();
    const [first] = A.getChangesMetaSince(handle.doc(), []).filter((c) => c.message?.includes("rename layer"));
    cleanup!.mark([first!.hash]);
    await frame();
    expect(container.querySelectorAll(".pw-hist__block--marked")).toHaveLength(1);
    expect(head(container, "@x/draw@1.2.0").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".pw-hist__change--marked")).toHaveLength(1);
  });

  it("renders a message as text", async () => {
    const { handle, container } = setup();
    handle.change((d) => (d.n = 2), { message: `<img src=x onerror=alert(1)>\npw:${KEY_A}` });
    await frame();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("follows the doc as it changes", async () => {
    const { handle, container } = setup();
    handle.change((d) => (d.n = 2), { message: `again\npw:${KEY_A}` });
    await frame();
    expect(container.querySelectorAll(".pw-hist__block")).toHaveLength(4);
    expect(container.querySelector(".pw-hist__session")!.textContent).toContain("again");
  });

  it("stops following and empties on cleanup", async () => {
    const { handle, container } = setup();
    cleanup!();
    cleanup = undefined;
    expect(container.childElementCount).toBe(0);
    handle.change((d) => (d.n = 2), { message: `again\npw:${KEY_A}` });
    await frame();
    expect(container.childElementCount).toBe(0);
  });
});
