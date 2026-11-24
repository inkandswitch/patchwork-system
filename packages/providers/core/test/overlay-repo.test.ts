import {
  Repo,
  generateAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
} from "@automerge/automerge-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OverlayRepo,
  accept,
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "../src/index.js";

type Note = { title: string };

let repo: Repo;
let note: DocHandle<Note>;
const teardowns: (() => void)[] = [];

beforeEach(() => {
  repo = new Repo();
  note = repo.create<Note>({ title: "note" });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.replaceChildren();
});

// A provider that answers every descriptor request for `url` with whatever
// `answers` currently maps it to, and stays silent for urls it maps to nothing.
function mount(answers: Map<AutomergeUrl, DocHandleDescriptor>) {
  const provider = document.createElement("div");
  const consumer = document.createElement("div");
  provider.append(consumer);
  document.body.append(provider);
  provider.addEventListener("patchwork:subscribe", (event: SubscribeEvent) => {
    const { selector } = event.detail;
    if (selector.type !== "repo:handle-descriptor") return;
    const answer = answers.get(selector.url as AutomergeUrl);
    if (!answer) return;
    accept<DocHandleDescriptor>(event, (respond) => {
      respond(answer);
      return () => {};
    });
  });
  const overlay = new OverlayRepo(repo, consumer);
  teardowns.push(() => overlay.dispose());
  return overlay;
}

// A document nothing can supply, so the realm-local repo reports it
// unavailable and `find` rejects.
function missing(): AutomergeUrl {
  return generateAutomergeUrl();
}

describe("findWithProgress failure", () => {
  it("reports unavailable to peek and subscribers, as the repo does", async () => {
    const url = missing();
    const overlay = mount(new Map([[url, { url }]]));
    const progress = overlay.findWithProgress<Note>(url);
    const seen: QueryState<Note>["state"][] = [];
    progress.subscribe((s) => seen.push(s.state));

    await expect(progress.whenReady()).rejects.toThrow();
    expect(progress.peek().state).toBe("unavailable");
    expect(progress.state).toBe("unavailable");
    expect(seen).toEqual(["unavailable"]);
  });

  it("tells a subscriber that arrives after the failure", async () => {
    const url = missing();
    const overlay = mount(new Map([[url, { url }]]));
    const progress = overlay.findWithProgress<Note>(url);
    await expect(progress.whenReady()).rejects.toThrow();
    expect(progress.peek().state).not.toBe("loading");
  });

  it("reports failed with the error when the backing find fails outright", async () => {
    const url = missing();
    const boom = new Error("boom");
    vi.spyOn(repo, "find").mockRejectedValue(boom);
    const overlay = mount(new Map([[url, { url }]]));
    const progress = overlay.findWithProgress<Note>(url);
    const seen: QueryState<Note>[] = [];
    progress.subscribe((s) => seen.push(s));

    await expect(progress.whenReady()).rejects.toBe(boom);
    const state = progress.peek();
    expect(state.state).toBe("failed");
    expect(progress.error).toBe(boom);
    expect(seen.map((s) => s.state)).toEqual(["failed"]);
  });

  it("leaves failed when a retry succeeds, including for the old subscribers", async () => {
    const url = missing();
    const answers = new Map<AutomergeUrl, DocHandleDescriptor>([[url, { url }]]);
    const overlay = mount(answers);
    const first = overlay.findWithProgress<Note>(url);
    const seen: string[] = [];
    first.subscribe((s) => seen.push(s.state));
    await expect(first.whenReady()).rejects.toThrow();

    // The document turns up under a different id; answer the retry with it.
    answers.set(url, { url: note.url });
    const retry = overlay.findWithProgress<Note>(url);
    expect(seen).toEqual(["unavailable", "loading"]);
    const handle = await retry.whenReady();

    expect(handle.url).toBe(url);
    expect(retry.peek().state).toBe("ready");
    expect(first.peek().state).toBe("ready");
    expect(first.error).toBeUndefined();
    expect(seen).toEqual(["unavailable", "loading", "ready"]);
  });

  it("evicts the rejection so a find retries", async () => {
    const url = missing();
    const answers = new Map<AutomergeUrl, DocHandleDescriptor>([[url, { url }]]);
    const overlay = mount(answers);
    await expect(overlay.find(url)).rejects.toThrow();
    answers.set(url, { url: note.url });
    const handle = await overlay.find<Note>(url);
    expect(handle.doc().title).toBe("note");
  });
});

describe("dispose", () => {
  it("rejects a pending find", async () => {
    // No provider answers, so the resolution stays pending.
    const overlay = mount(new Map());
    const pending = overlay.find(note.url);
    overlay.dispose();
    await expect(pending).rejects.toThrow("OverlayRepo disposed");
  });

  it("reports a pending findWithProgress as failed and leaves nothing unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const overlay = mount(new Map());
      const progress = overlay.findWithProgress<Note>(note.url);
      const seen: string[] = [];
      progress.subscribe((s) => seen.push(s.state));
      overlay.dispose();
      expect(seen).toEqual(["failed"]);
      expect(progress.peek().state).toBe("failed");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
