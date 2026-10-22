import { next as A } from "@automerge/automerge";
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OverlayRepo,
  providePatchLayers,
  registerRepoProviderElement,
} from "../src/index.js";

import {
  LayeredDoc,
  createPatch,
  fromAutomergePatches,
  landPatch,
  textPatch,
  type PatchDoc,
  type TextPatch,
} from "../src/patch-layers.js";

let repo: Repo;
let scratch: Repo;

beforeEach(() => {
  repo = new Repo();
  scratch = new Repo();
});

// What a fresh overlay over the same target and patches shows: what the live
// one should show too, if every write was routed somewhere.
function fresh<T>(base: DocHandle<T>, layers: DocHandle<PatchDoc>[]) {
  const l = new LayeredDoc(base, layers, scratch);
  const doc = l.handle.doc();
  l.dispose();
  return doc;
}

describe("value patches on list indexes", () => {
  type Clock = { title: string; items: string[] };
  let clock: DocHandle<Clock>;
  beforeEach(() => {
    clock = repo.create<Clock>({ title: "clock", items: ["a", "b", "c"] });
  });

  it("a remove patch on a list index removes only one item, however often it's laid", () => {
    const skin = createPatch(repo, clock, [{ path: ["items", 0] }]);
    const layered = new LayeredDoc(clock, [skin], scratch);
    expect(layered.handle.doc().items).toEqual(["b", "c"]);
    clock.change((d) => {
      d.title = "x";
    });
    expect(layered.handle.doc().items).toEqual(["b", "c"]);
  });

  it("an edit beside a hidden item goes to the item it was made on", () => {
    const skin = createPatch(repo, clock, [{ path: ["items", 0] }]);
    const layered = new LayeredDoc(clock, [skin], scratch);
    expect(layered.handle.doc().items).toEqual(["b", "c"]);
    layered.handle.change((d) => {
      d.items[1] = "C"; // the overlay's [1] is the target's [2]
    });
    expect(clock.doc().items).toEqual(["a", "b", "C"]);
    expect(layered.handle.doc().items).toEqual(["b", "C"]);
  });

  it("the target inserting at a patched list index keeps the overlay's list in step", () => {
    const skin = createPatch(repo, clock, [{ path: ["items", 0], value: "z" }]);
    const layered = new LayeredDoc(clock, [skin], scratch);
    expect(layered.handle.doc().items).toEqual(["z", "b", "c"]);
    clock.change((d) => {
      d.items.insertAt(0, "new");
    });
    // The patch follows the index: [new, a, b, c] with index 0 -> z.
    expect(layered.handle.doc().items).toEqual(fresh(clock, [skin]).items);
  });
});

describe("text patches", () => {
  type Story = { content: string; other: string; n: number };
  let story: DocHandle<Story>;
  const TEXT = "The tail swings, the eyes roll.";
  beforeEach(() => {
    story = repo.create<Story>({ content: TEXT, other: "foo bar", n: 1 });
  });

  it("one write editing the target's text on both sides of a run sends both to the target", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 15, "wags"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    layered.handle.change((d) => {
      A.splice(d, ["content"], 0, 0, "X");
      A.splice(d, ["content"], d.content.length, 0, "Y");
    });
    expect(layered.handle.doc().content).toBe("XThe tail wags, the eyes roll.Y");
    expect(story.doc().content).toBe("X" + TEXT + "Y");
    expect((patch.doc().patches[0] as TextPatch).text.insert).toBe("wags");
  });

  it("merging entries on one string doesn't lose an edit to another string in the same write", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 0, 3, "A"), // "A tail swings..."
      textPatch(story, ["content"], 4, 8, "B"), // "A B swings..."
      textPatch(story, ["other"], 0, 3, "FU"), // "FU bar"
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    expect(layered.handle.doc().content).toBe("A B swings, the eyes roll.");
    expect(layered.handle.doc().other).toBe("FU bar");
    layered.handle.change((d) => {
      // delete " " between A and B: touches both entries, which merge
      A.splice(d, ["content"], 1, 1, "");
      // type inside the other string's entry
      A.splice(d, ["other"], 2, 0, "Z");
    });
    expect(layered.handle.doc().other).toBe("FUZ bar");
    expect(fresh(story, [patch]).other).toBe("FUZ bar");
  });

  it("marking in the same write as a text edit marks what was marked", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 15, "wags"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    layered.handle.change((d) => {
      A.splice(d, ["content"], 0, 0, "XX");
      // "XXThe tail wags," : "tail" is 6..10
      A.mark(d, ["content"], { start: 6, end: 10, expand: "none" }, "em", true);
    });
    expect(story.doc().content).toBe("XX" + TEXT);
    expect(A.marks(story.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 6, end: 10 },
    ]);
    expect(patch.doc().patches.some((e) => "mark" in e)).toBe(false);
  });

  it("deleting a patched string isn't silently dropped", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 15, "wags"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    layered.handle.change((d) => {
      delete (d as Partial<Story>).content;
    });
    expect("content" in layered.handle.doc()).toBe(false);
    expect("content" in fresh(story, [patch])).toBe(false);
  });

  it("a value patch added over a text-patched string shows straight away", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 15, "wags"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    patch.change((d) => {
      d.patches.push({ path: ["content"], value: "whole" });
    });
    expect(layered.handle.doc().content).toBe("whole");
  });

  it("lands an insertion at a run's start the way the overlay shows it", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 9, "!"),
      textPatch(story, ["content"], 9, 15, "wags"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    const shown = layered.handle.doc().content;
    expect(shown).toBe("The tail !wags, the eyes roll.");
    landPatch(story, patch);
    expect(story.doc().content).toBe(shown);
  });

  it("lands two insertions at one point in the order the overlay shows them", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 0, 0, "A"),
      textPatch(story, ["content"], 0, 0, "B"),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    const shown = layered.handle.doc().content;
    landPatch(story, patch);
    expect(story.doc().content).toBe(shown);
  });

  it("landing a text patch never shows its text twice", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 0, 0, "Oh! "),
    ]);
    const layered = new LayeredDoc(story, [patch], scratch);
    const seen: string[] = [];
    layered.handle.on("change", ({ doc }) => seen.push(doc.content));
    landPatch(story, patch);
    for (const s of seen) expect(s).toBe("Oh! " + TEXT);
  });

  it("converts a splice into a string an earlier op put", () => {
    const { entries, errors } = fromAutomergePatches(story, [
      { action: "put", path: ["content"], value: "abc" },
      { action: "splice", path: ["content", 3], value: "d" },
    ]);
    expect(errors).toEqual([]);
    const patch = createPatch(repo, story, entries);
    expect(fresh(story, [patch]).content).toBe("abcd");
  });

  it("converts a mark on added text, then an edit before it, keeping the mark on its letters", () => {
    const { entries, errors } = fromAutomergePatches(story, [
      { action: "del", path: ["content", 9], length: 6 },
      { action: "splice", path: ["content", 9], value: "wags" },
      {
        action: "mark",
        path: ["content"],
        marks: [{ name: "strong", value: true, start: 10, end: 13 }],
      },
      // "The tail swags," : "ags" is now 11..14
      { action: "splice", path: ["content", 9], value: "s" },
    ]);
    expect(errors).toEqual([]);
    const patch = createPatch(repo, story, entries);
    const layered = new LayeredDoc(story, [patch], scratch);
    expect(layered.handle.doc().content).toBe("The tail swags, the eyes roll.");
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "strong", value: true, start: 11, end: 14 },
    ]);
  });
});

describe("overlay repo leases", () => {
  it("re-laying doesn't tell consumers the document was deleted", async () => {
    registerRepoProviderElement(repo);
    const clock = repo.create({ theme: { accent: "lemon" } });
    const skin = createPatch(repo, clock, [{ path: ["theme", "accent"], value: "cherry" }]);
    const skin2 = createPatch(repo, clock, [{ path: ["theme", "accent"], value: "plum" }]);
    const folder = repo.create<{ docs: { type: string; url: AutomergeUrl }[] }>({
      docs: [{ type: "patch", url: skin.url }],
    });
    const root = document.createElement("repo-provider");
    document.body.append(root);
    const el = document.createElement("div");
    root.append(el);
    const teardown = providePatchLayers(el, { repo, folder: folder.url });
    const consumer = document.createElement("div");
    el.append(consumer);
    const overlay = new OverlayRepo(repo, consumer, { scratchRepo: scratch });
    const handle = await overlay.find<{ theme: { accent: string } }>(clock.url);
    expect(handle.doc().theme.accent).toBe("cherry");
    const deleted = vi.fn();
    handle.on("delete", deleted);
    folder.change((d) => {
      d.docs.push({ type: "patch", url: skin2.url });
    });
    await vi.waitFor(() => expect(handle.doc().theme.accent).toBe("plum"));
    expect(deleted).not.toHaveBeenCalled();
    overlay.dispose();
    teardown();
    document.body.replaceChildren();
  });
});
