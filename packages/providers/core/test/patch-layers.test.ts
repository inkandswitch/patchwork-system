import { next as A } from "@automerge/automerge";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import { beforeEach, describe, expect, it } from "vitest";

import {
  LayeredDoc,
  createPatch,
  fromAutomergePatches,
  isEntryStale,
  isPatchStale,
  landPatch,
  markPatch,
  patchHighlights,
  readEntry,
  textPatch,
  type PatchDoc,
  type TextPatch,
} from "../src/patch-layers.js";

type Clock = {
  theme: { accent: string; font: string };
  title: string;
  items: string[];
};

let repo: Repo;
let scratch: Repo;
let clock: DocHandle<Clock>;

beforeEach(() => {
  repo = new Repo();
  scratch = new Repo();
  clock = repo.create<Clock>({
    theme: { accent: "lemon", font: "chicago" },
    title: "clock",
    items: ["a", "b"],
  });
});

function lay(...layers: DocHandle<PatchDoc>[]) {
  return new LayeredDoc(clock, layers, scratch);
}

describe("LayeredDoc", () => {
  it("shows the patch over the target without writing on it", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    expect(layered.handle.doc().theme).toEqual({
      accent: "cherry",
      font: "chicago",
    });
    expect(clock.doc().theme.accent).toBe("lemon");
  });

  it("removes what's at a path when the patch has no value", () => {
    const skin = createPatch(repo, clock, [{ path: ["theme", "font"] }]);
    const layered = lay(skin);
    expect(layered.handle.doc().theme).toEqual({ accent: "lemon" });
  });

  it("lets the target's changes through, except where a patch covers", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    clock.change((d) => {
      d.theme.font = "geneva";
      d.theme.accent = "lime";
      A.splice(d, ["title"], 5, 0, " face");
    });
    expect(layered.handle.doc()).toMatchObject({
      theme: { accent: "cherry", font: "geneva" },
      title: "clock face",
    });
  });

  it("puts the patch back when the target replaces what it sits in", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    clock.change((d) => {
      d.theme = { accent: "lime", font: "monaco" };
    });
    expect(layered.handle.doc().theme).toEqual({
      accent: "cherry",
      font: "monaco",
    });
  });

  it("sends writes outside every patch to the target", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    layered.handle.change((d) => {
      d.theme.font = "geneva";
      A.splice(d, ["title"], 0, 0, "cat");
      d.items.push("c");
    });
    expect(clock.doc()).toMatchObject({
      theme: { accent: "lemon", font: "geneva" },
      title: "catclock",
      items: ["a", "b", "c"],
    });
    expect(skin.doc().patches).toEqual([
      { path: ["theme", "accent"], value: "cherry" },
    ]);
  });

  it("lands writes under a patch in the patch (copy-up)", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    layered.handle.change((d) => {
      A.splice(d, ["theme", "accent"], 6, 0, " red");
    });
    expect(layered.handle.doc().theme.accent).toBe("cherry red");
    expect(skin.doc().patches[0].value).toBe("cherry red");
    expect(clock.doc().theme.accent).toBe("lemon");
  });

  it("sends a deleted key to the target", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    layered.handle.change((d) => {
      delete (d.theme as Partial<Clock["theme"]>).font;
    });
    expect(clock.doc().theme).toEqual({ accent: "lemon" });
    expect(layered.handle.doc().theme).toEqual({ accent: "cherry" });
    clock.change((d) => {
      delete (d as Partial<Clock>).title;
    });
    expect("title" in layered.handle.doc()).toBe(false);
  });

  it("routes writes made through sub-handles", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    layered.handle.sub("theme").change((theme) => {
      theme.font = "geneva";
      theme.accent = "plum";
    });
    expect(clock.doc().theme).toEqual({ accent: "lemon", font: "geneva" });
    expect(skin.doc().patches[0].value).toBe("plum");
  });

  it("follows the target's text edits in step with its own", () => {
    const layered = lay(
      createPatch(repo, clock, [{ path: ["theme", "accent"], value: "cherry" }])
    );
    layered.handle.change((d) => A.splice(d, ["title"], 5, 0, "!"));
    clock.change((d) => A.splice(d, ["title"], 0, 0, ">"));
    layered.handle.change((d) => A.splice(d, ["title"], 7, 0, "?"));
    expect(clock.doc().title).toBe(">clock!?");
    expect(layered.handle.doc().title).toBe(">clock!?");
  });

  it("shows the target again when a patch is taken out", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    clock.change((d) => {
      d.theme.accent = "lime";
    });
    skin.change((d) => {
      d.patches.splice(0, 1);
    });
    expect(layered.handle.doc().theme.accent).toBe("lime");
  });

  it("picks up a patch added to a layer", () => {
    const skin = createPatch(repo, clock);
    const layered = lay(skin);
    skin.change((d) => {
      d.patches.push({ path: ["title"], value: "cat clock" });
    });
    expect(layered.handle.doc().title).toBe("cat clock");
  });

  it("puts the front layer on top", () => {
    const back = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
      { path: ["theme", "font"], value: "monaco" },
    ]);
    const front = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "plum" },
    ]);
    const layered = lay(front, back);
    expect(layered.handle.doc().theme).toEqual({
      accent: "plum",
      font: "monaco",
    });
    expect(layered.describe(["theme", "accent"])).toEqual([
      { from: front.url, value: "plum" },
      { from: back.url, value: "cherry" },
      { from: "base", value: "lemon" },
    ]);

    // A write shows where it was made: in the front layer covering it.
    layered.handle.change((d) => {
      d.theme.accent = "pear";
    });
    expect(front.doc().patches[0].value).toBe("pear");
    expect(back.doc().patches[0].value).toBe("cherry");
  });

  it("says when a patch is stale, and still applies it", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    clock.change((d) => {
      d.title = "elsewhere";
    });
    expect(isPatchStale(clock, skin.doc())).toBe(false);

    clock.change((d) => {
      d.theme.accent = "lime";
    });
    expect(isPatchStale(clock, skin.doc())).toBe(true);
    expect(layered.describe(["theme", "accent"])[0]).toEqual({
      from: skin.url,
      value: "cherry",
      stale: true,
    });
    expect(layered.handle.doc().theme.accent).toBe("cherry");
  });

  it("sets aside a patch whose parent isn't there", () => {
    const skin = createPatch(repo, clock, [
      { path: ["missing", "deep"], value: 1 },
    ]);
    const layered = lay(skin);
    expect(layered.describe(["missing", "deep"])[0]).toEqual({
      from: skin.url,
      value: 1,
      error: "no-parent",
    });
    expect("missing" in layered.handle.doc()).toBe(false);
  });

  it("lands a patch on the target without the overlay changing", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    let changes = 0;
    layered.handle.on("change", () => changes++);
    landPatch(clock, skin);
    expect(clock.doc().theme.accent).toBe("cherry");
    expect(skin.doc().patches).toEqual([]);
    expect(skin.doc().landedAt).toEqual(clock.heads());
    expect(layered.handle.doc().theme.accent).toBe("cherry");
    expect(changes).toBe(0);
  });

  it("stops following once disposed", () => {
    const skin = createPatch(repo, clock, [
      { path: ["theme", "accent"], value: "cherry" },
    ]);
    const layered = lay(skin);
    layered.dispose();
    clock.change((d) => {
      d.title = "after";
    });
    expect(layered.handle.doc().title).toBe("clock");
  });
});

describe("text patches", () => {
  type Story = { content: string; n: number };
  let story: DocHandle<Story>;
  const TEXT = "The tail swings, the eyes roll.";
  // "swings" is 9..15.

  beforeEach(() => {
    story = repo.create<Story>({ content: TEXT, n: 1 });
  });

  const wags = () =>
    createPatch(repo, story, [textPatch(story, ["content"], 9, 15, "wags")]);
  const layOn = (...layers: DocHandle<PatchDoc>[]) =>
    new LayeredDoc(story, layers, scratch);
  const insertOf = (p: DocHandle<PatchDoc>, i = 0) =>
    (p.doc().patches[i] as TextPatch).text.insert;

  it("replaces a run of a string without writing on it", () => {
    const layered = layOn(wags());
    expect(layered.handle.doc().content).toBe("The tail wags, the eyes roll.");
    expect(story.doc().content).toBe(TEXT);
  });

  it("moves with the target's edits around the run", () => {
    const layered = layOn(wags());
    story.change((d) => A.splice(d, ["content"], 0, 0, "Oh! "));
    story.change((d) => A.splice(d, ["content"], 19, 0, " slowly"));
    expect(story.doc().content).toBe("Oh! The tail swings slowly, the eyes roll.");
    expect(layered.handle.doc().content).toBe(
      "Oh! The tail wags slowly, the eyes roll."
    );
  });

  it("puts typing inside the run into the patch, and typing elsewhere on the target", () => {
    const patch = wags();
    const layered = layOn(patch);
    // "The tail wags|" -> "wagss"
    layered.handle.change((d) => A.splice(d, ["content"], 13, 0, "s"));
    expect(insertOf(patch)).toBe("wagss");
    expect(story.doc().content).toBe(TEXT);
    // after the comma: the target's own text
    layered.handle.change((d) => A.splice(d, ["content"], 20, 0, "big "));
    expect(story.doc().content).toBe("The tail swings, the big eyes roll.");
    expect(layered.handle.doc().content).toBe(
      "The tail wagss, the big eyes roll."
    );
  });

  it("folds a deletion across the run's edge into the patch", () => {
    const patch = wags();
    const layered = layOn(patch);
    // delete "l wa" from "tail wags"
    layered.handle.change((d) => A.splice(d, ["content"], 7, 4, ""));
    expect(layered.handle.doc().content).toBe("The taigs, the eyes roll.");
    expect(story.doc().content).toBe(TEXT);
    const entry = patch.doc().patches[0] as TextPatch;
    expect(entry.text.insert).toBe("gs");
    expect(readEntry(story, patch.doc(), entry).now).toBe("l swings");
  });

  it("goes stale when the target changes the words it replaces", () => {
    const patch = wags();
    layOn(patch);
    story.change((d) => A.splice(d, ["content"], 0, 0, "Oh! "));
    expect(isEntryStale(story, patch.doc(), patch.doc().patches[0])).toBe(false);
    story.change((d) => A.splice(d, ["content"], 16, 0, "XX"));
    const reading = readEntry(story, patch.doc(), patch.doc().patches[0]);
    expect(reading).toMatchObject({
      kind: "text",
      stale: true,
      then: "swings",
      now: "swiXXngs",
    });
  });

  it("goes on replacing the words when someone retypes them", () => {
    const patch = wags();
    const layered = layOn(patch);
    story.change((d) => A.splice(d, ["content"], 9, 6, "sways"));
    expect(story.doc().content).toBe("The tail sways, the eyes roll.");
    expect(layered.handle.doc().content).toBe("The tail wags, the eyes roll.");
    const entry = patch.doc().patches[0];
    expect(readEntry(story, patch.doc(), entry)).toMatchObject({
      stale: true,
      then: "swings",
      now: "sways",
    });
    // Keeping it measures it from now: no longer stale, still replacing.
    const heads = story.heads();
    patch.change((d) => {
      d.patches[0].at = heads;
    });
    expect(isEntryStale(story, patch.doc(), patch.doc().patches[0])).toBe(false);
    landPatch(story, patch);
    expect(story.doc().content).toBe("The tail wags, the eyes roll.");
  });

  it("goes stale when the target replaces the whole string", () => {
    const patch = wags();
    const layered = layOn(patch);
    story.change((d) => {
      d.content = "Something else entirely.";
    });
    expect(readEntry(story, patch.doc(), patch.doc().patches[0]).stale).toBe(true);
    expect(layered.handle.doc().content.startsWith("Something else")).toBe(true);
  });

  it("shrinks to a point when the target deletes the run", () => {
    const patch = wags();
    const layered = layOn(patch);
    story.change((d) => A.splice(d, ["content"], 9, 6, ""));
    expect(layered.handle.doc().content).toBe("The tail wags, the eyes roll.");
    expect(readEntry(story, patch.doc(), patch.doc().patches[0]).stale).toBe(true);
  });

  it("shows the target's text again when the entry is taken out", () => {
    const patch = wags();
    const layered = layOn(patch);
    patch.change((d) => {
      d.patches.splice(0, 1);
    });
    expect(layered.handle.doc().content).toBe(TEXT);
  });

  it("marks a run without marking the target", () => {
    const patch = createPatch(repo, story, [
      markPatch(story, ["content"], 21, 25, "em", true),
    ]);
    const layered = layOn(patch);
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 21, end: 25 },
    ]);
    expect(A.marks(story.doc(), ["content"])).toEqual([]);
  });

  it("lands text and marks on the target for real", () => {
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 9, 15, "wags"),
      markPatch(story, ["content"], 21, 25, "em", true),
    ]);
    const layered = layOn(patch);
    landPatch(story, patch);
    expect(story.doc().content).toBe("The tail wags, the eyes roll.");
    expect(A.marks(story.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 19, end: 23 },
    ]);
    expect(layered.handle.doc().content).toBe("The tail wags, the eyes roll.");
  });

  it("says where landed text ended up, for marks on it elsewhere", () => {
    const entry = textPatch(story, ["content"], 9, 15, "wags");
    const patch = createPatch(repo, story, [
      textPatch(story, ["content"], 0, 0, "Oh! "),
      entry,
    ]);
    layOn(patch);
    const landed = landPatch(story, patch);
    expect(story.doc().content).toBe("Oh! The tail wags, the eyes roll.");
    expect(landed.get(entry.text.id!)).toBe(13);
  });

  it("records writes into the recording patch", () => {
    const patch = createPatch(repo, story);
    patch.change((d) => {
      d.record = true;
    });
    const layered = layOn(patch);
    layered.handle.change((d) => {
      d.n = 7;
    });
    layered.handle.change((d) => A.splice(d, ["content"], 4, 0, "long "));
    expect(story.doc()).toEqual({ content: TEXT, n: 1 });
    expect(layered.handle.doc()).toEqual({
      content: "The long tail swings, the eyes roll.",
      n: 7,
    });
    // Typing on from there stays in the same entry.
    layered.handle.change((d) => A.splice(d, ["content"], 9, 0, "y"));
    const patches = patch.doc().patches;
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ path: ["n"], value: 7 });
    expect((patches[1] as TextPatch).text.insert).toBe("long y");
    expect(layered.handle.doc().content).toBe(
      "The long ytail swings, the eyes roll."
    );
  });

  it("lays a patch once when one overlay sits on another", () => {
    const patch = createPatch(repo, story);
    patch.change((d) => {
      d.record = true;
    });
    const outer = layOn(patch);
    const inner = new LayeredDoc(outer.handle, [patch], scratch);
    for (const ch of " Tick") {
      const len = inner.handle.doc().content.length;
      inner.handle.change((d) => A.splice(d, ["content"], len, 0, ch));
    }
    expect(inner.handle.doc().content).toBe(TEXT + " Tick");
    expect(outer.handle.doc().content).toBe(TEXT + " Tick");
    expect(story.doc().content).toBe(TEXT);
    expect(patch.doc().patches).toHaveLength(1);
    expect(insertOf(patch)).toBe(" Tick");
  });

  it("marks text a patch adds, and keeps the mark on it as it's edited", () => {
    const { entries, errors } = fromAutomergePatches(story, [
      { action: "del", path: ["content", 9], length: 6 },
      { action: "splice", path: ["content", 9], value: "wags" },
      // "The tail wags," -> mark "ags" (10..13), all patch-added text
      {
        action: "mark",
        path: ["content"],
        marks: [{ name: "strong", value: true, start: 10, end: 13 }],
      },
    ]);
    expect(errors).toEqual([]);
    const patch = createPatch(repo, story, entries);
    const layered = layOn(patch);
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "strong", value: true, start: 10, end: 13 },
    ]);
    // Type at the start of the added text: the mark moves with its letters.
    layered.handle.change((d) => A.splice(d, ["content"], 9, 0, "s"));
    expect(layered.handle.doc().content).toBe("The tail swags, the eyes roll.");
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "strong", value: true, start: 11, end: 14 },
    ]);
    expect(A.marks(story.doc(), ["content"])).toEqual([]);
    landPatch(story, patch);
    expect(story.doc().content).toBe("The tail swags, the eyes roll.");
    expect(A.marks(story.doc(), ["content"])).toEqual([
      { name: "strong", value: true, start: 11, end: 14 },
    ]);
  });

  it("splits an editor's mark across the target's text and a patch's", () => {
    const patch = wags();
    const layered = layOn(patch);
    // "The tail wags," : mark "tail wa" (4..11): 4..9 is the target's, 9..11
    // is the patch's.
    layered.handle.change((d) =>
      A.mark(d, ["content"], { start: 4, end: 11, expand: "none" }, "em", true)
    );
    expect(A.marks(story.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 4, end: 9 },
    ]);
    const within = patch.doc().patches.find((e) => "mark" in e);
    expect(within).toMatchObject({ mark: { name: "em", start: 0, end: 2 } });
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 4, end: 11 },
    ]);
  });

  it("says what to highlight, through a nested overlay too", () => {
    const patch = wags();
    const outer = layOn(patch);
    const inner = new LayeredDoc(outer.handle, [patch], scratch);
    const want = [
      expect.objectContaining({
        start: 9,
        end: 13,
        patch: patch.url,
        replaced: "swings",
        index: 0,
        base: { start: 9, end: 15 },
      }),
    ];
    expect(patchHighlights(outer.handle, ["content"])).toEqual(want);
    expect(patchHighlights(inner.handle, ["content"])).toEqual(want);
    expect(patchHighlights(story, ["content"])).toEqual([]);
  });

  it("turns Automerge patches into cursor entries", () => {
    const { entries, errors } = fromAutomergePatches(story, [
      { action: "del", path: ["content", 9], length: 6 },
      { action: "splice", path: ["content", 9], value: "wags" },
      { action: "put", path: ["n"], value: 2 },
      {
        action: "mark",
        path: ["content"],
        marks: [{ name: "em", value: true, start: 19, end: 23 }],
      },
      { action: "splice", path: ["content", 99], value: "!" },
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ index: 4, code: "past-end" }),
    ]);
    const patch = createPatch(repo, story, entries);
    const layered = layOn(patch);
    expect(layered.handle.doc().content).toBe("The tail wags, the eyes roll.");
    expect(layered.handle.doc().n).toBe(2);
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "em", value: true, start: 19, end: 23 },
    ]);
  });
});

describe("recording over an older patch", () => {
  type Story = { content: string; n: number; items: string[] };
  let story: DocHandle<Story>;
  const TEXT = "The tail swings, the eyes roll.";

  beforeEach(() => {
    story = repo.create<Story>({ content: TEXT, n: 1, items: ["a", "b", "c"] });
  });

  // `old` laid behind a new, recording patch, as the panel stacks them.
  const recordOver = (old: DocHandle<PatchDoc>) => {
    const rec = createPatch(repo, story);
    rec.change((d) => void (d.record = true));
    const layered = new LayeredDoc(story, [rec, old], scratch);
    const fresh = () => new LayeredDoc(story, [rec, old], scratch).handle.doc();
    const oldAlone = () => new LayeredDoc(story, [old], scratch).handle.doc();
    return { rec, layered, fresh, oldAlone };
  };

  it("records a value the old patch puts", () => {
    const old = createPatch(repo, story, [{ path: ["n"], value: 5 }]);
    const { rec, layered, oldAlone } = recordOver(old);
    layered.handle.change((d) => void (d.n = 7));
    expect(layered.handle.doc().n).toBe(7);
    expect(old.doc().patches).toEqual([{ path: ["n"], value: 5 }]);
    expect(rec.doc().patches).toMatchObject([{ path: ["n"], value: 7 }]);
    expect(oldAlone().n).toBe(5);
    expect(story.doc().n).toBe(1);
  });

  it("records an edit to a string the old patch puts", () => {
    const old = createPatch(repo, story, [{ path: ["content"], value: "hello" }]);
    const { rec, layered, fresh, oldAlone } = recordOver(old);
    layered.handle.change((d) => A.splice(d, ["content"], 5, 0, "!"));
    expect(layered.handle.doc().content).toBe("hello!");
    expect(fresh().content).toBe("hello!");
    expect(rec.doc().patches).toMatchObject([{ path: ["content"], value: "hello!" }]);
    expect(oldAlone().content).toBe("hello");
  });

  it("records an edit inside text the old patch replaces", () => {
    const old = createPatch(repo, story, [textPatch(story, ["content"], 9, 15, "wags")]);
    const { rec, layered, fresh, oldAlone } = recordOver(old);
    // "The tail wags," -> "The tail wiggles,"
    layered.handle.change((d) => A.splice(d, ["content"], 10, 2, "iggle"));
    const want = "The tail wiggles, the eyes roll.";
    expect(layered.handle.doc().content).toBe(want);
    expect(fresh().content).toBe(want);
    expect((old.doc().patches[0] as TextPatch).text.insert).toBe("wags");
    expect(rec.doc().patches).toHaveLength(1);
    expect(oldAlone().content).toBe("The tail wags, the eyes roll.");
    expect(story.doc().content).toBe(TEXT);
  });

  it("records an edit inside text the old patch inserts, without showing it twice", () => {
    const old = createPatch(repo, story, [textPatch(story, ["content"], 4, 4, "long ")]);
    const { rec, layered, fresh, oldAlone } = recordOver(old);
    layered.handle.change((d) => A.splice(d, ["content"], 6, 0, "NG"));
    const want = "The loNGng tail swings, the eyes roll.";
    expect(layered.handle.doc().content).toBe(want);
    expect(fresh().content).toBe(want);
    expect((old.doc().patches[0] as TextPatch).text.insert).toBe("long ");
    expect(rec.doc().patches).toHaveLength(1);
    expect(oldAlone().content).toBe("The long tail swings, the eyes roll.");
    // And again, now that it's the recording patch's own.
    layered.handle.change((d) => A.splice(d, ["content"], 4, 1, "L"));
    expect(layered.handle.doc().content).toBe("The LoNGng tail swings, the eyes roll.");
    expect(fresh().content).toBe("The LoNGng tail swings, the eyes roll.");
    expect(rec.doc().patches).toHaveLength(1);
  });

  it("records typing right before and after text the old patch inserts", () => {
    const old = createPatch(repo, story, [textPatch(story, ["content"], 4, 4, "long ")]);
    const { layered, fresh, oldAlone } = recordOver(old);
    layered.handle.change((d) => A.splice(d, ["content"], 4, 0, "<"));
    layered.handle.change((d) => A.splice(d, ["content"], 10, 0, ">"));
    const want = "The <long >tail swings, the eyes roll.";
    expect(layered.handle.doc().content).toBe(want);
    expect(fresh().content).toBe(want);
    expect(oldAlone().content).toBe("The long tail swings, the eyes roll.");
  });

  it("records a mark on text the old patch adds, and keeps it when that text is taken over", () => {
    const old = createPatch(repo, story, [textPatch(story, ["content"], 9, 15, "wags")]);
    const { rec, layered, fresh } = recordOver(old);
    layered.handle.change((d) =>
      A.mark(d, ["content"], { start: 9, end: 13, expand: "none" }, "strong", true)
    );
    expect(old.doc().patches).toHaveLength(1);
    layered.handle.change((d) => A.splice(d, ["content"], 13, 0, "!"));
    expect(layered.handle.doc().content).toBe("The tail wags!, the eyes roll.");
    expect(A.marks(layered.handle.doc(), ["content"])).toEqual([
      { name: "strong", value: true, start: 9, end: 13 },
    ]);
    expect(A.marks(fresh(), ["content"])).toEqual([
      { name: "strong", value: true, start: 9, end: 13 },
    ]);
    expect(old.doc().patches).toHaveLength(1);
    expect(rec.doc().patches.length).toBeGreaterThan(0);
  });

  it("records a write into a list the old patch patches", () => {
    const old = createPatch(repo, story, [{ path: ["items", 0], value: "A" }]);
    const { rec, layered, fresh, oldAlone } = recordOver(old);
    layered.handle.change((d) => void (d.items[1] = "B"));
    layered.handle.change((d) => void (d.items[0] = "AA"));
    expect(layered.handle.doc().items).toEqual(["AA", "B", "c"]);
    expect(fresh().items).toEqual(["AA", "B", "c"]);
    expect(story.doc().items).toEqual(["a", "b", "c"]);
    expect(old.doc().patches).toEqual([{ path: ["items", 0], value: "A" }]);
    expect(rec.doc().patches.length).toBeGreaterThan(0);
    expect(oldAlone().items).toEqual(["A", "b", "c"]);
  });

  it("still copies up into a patch in front of the recording one", () => {
    const front = createPatch(repo, story, [{ path: ["n"], value: 5 }]);
    const rec = createPatch(repo, story);
    rec.change((d) => void (d.record = true));
    const layered = new LayeredDoc(story, [front, rec], scratch);
    layered.handle.change((d) => void (d.n = 7));
    expect(layered.handle.doc().n).toBe(7);
    expect(front.doc().patches).toMatchObject([{ path: ["n"], value: 7 }]);
  });
});
