// Pinned cases for what the fuzzers only hit by chance.
import { next as A } from "@automerge/automerge";
import {
  Repo,
  cursor,
  generateAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getScratchRepo } from "../src/index.js";
import { backedBy, mount, settle, unmountAll } from "./harness.js";

type Note = { title: string; text: string };

afterEach(() => {
  vi.restoreAllMocks();
  unmountAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("a re-answered descriptor", () => {
  it("isn't failed by an older answer that fails after it", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "" });
    const first = repo.clone(note);
    const second = repo.clone(note);
    second.change((d) => {
      d.title = "second";
    });
    const pending = new Map<
      AutomergeUrl,
      ReturnType<typeof deferred<DocHandle<Note>>>
    >();
    const find = repo.find.bind(repo);
    vi.spyOn(repo, "find").mockImplementation(((url: AutomergeUrl) => {
      const gate = pending.get(url);
      return gate ? gate.promise : find(url);
    }) as typeof repo.find);
    pending.set(first.url, deferred());
    pending.set(second.url, deferred());

    const view = mount(repo);
    view.route(note.url, { url: note.url, cloneUrl: first.url });
    const found = view.overlay.find<Note>(note.url);
    await vi.waitFor(() => expect(repo.find).toHaveBeenCalledWith(first.url));
    view.route(note.url, { url: note.url, cloneUrl: second.url });
    await vi.waitFor(() => expect(repo.find).toHaveBeenCalledWith(second.url));

    // The superseded answer fails while the newer one is still loading.
    pending.get(first.url)!.reject(new Error("first is unavailable"));
    await settle();
    pending.get(second.url)!.resolve(second);

    const handle = await found;
    expect(handle.url).toBe(note.url);
    expect(handle.doc().title).toBe("second");
    // Still subscribed: a later answer still re-points it.
    view.route(note.url, { url: note.url });
    await backedBy(handle, note);
    expect(await view.overlay.find(note.url)).toBe(handle);
  });
});

describe("a retry", () => {
  it("is joined, not doubled, by a subscriber that finds again on hearing it start", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "" });
    // Nothing can supply it, so the first attempt fails.
    const url = generateAutomergeUrl();
    const view = mount(repo);
    const progress = view.overlay.findWithProgress<Note>(url);
    await expect(progress.whenReady()).rejects.toThrow();
    // An unsubscribe reaches the provider over its port.
    await settle();
    expect(view.subscribers(url)).toBe(0);

    view.route(url, { url, cloneUrl: note.url });
    let nested: Promise<DocHandle<Note>> | undefined;
    progress.subscribe((state) => {
      if (state.state === "loading") nested ??= progress.whenReady();
    });
    const retry = view.overlay.find<Note>(url);
    expect(nested).toBeDefined();
    expect(view.subscribers(url)).toBe(1);
    const [found, joined] = await Promise.all([retry, nested]);
    expect(joined).toBe(found);
    expect(found.doc().title).toBe("note");
  });

  it("started by a subscriber hearing the failure keeps its own subscription", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "" });
    const url = generateAutomergeUrl();
    const view = mount(repo);
    const progress = view.overlay.findWithProgress<Note>(url);
    // The first attempt has had its answer; the retry's waits for a route.
    view.silence(url);
    let retry: Promise<DocHandle<Note>> | undefined;
    progress.subscribe((state) => {
      if (state.state === "unavailable") retry ??= view.overlay.find(url);
    });
    await expect(progress.whenReady()).rejects.toThrow();
    expect(retry).toBeDefined();
    await settle();
    expect(view.subscribers(url)).toBe(1);

    // Heard only if the retry's subscription is the one still open.
    view.route(url, { url, cloneUrl: note.url });
    expect((await retry!).doc().title).toBe("note");
  });
});

describe("a remapper's pinned backing", () => {
  it("still gives views that stay where they were", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "" });
    const pin = () =>
      stringifyAutomergeUrl({
        documentId: note.documentId,
        heads: note.heads(),
      });
    const view = mount(repo);
    view.route(note.url, { url: note.url, cloneUrl: pin() });
    const handle = await view.overlay.find<Note>(note.url);
    const snapshot = handle.view(handle.heads());
    expect(snapshot).not.toBe(handle);
    expect(snapshot.url).toBe(pin());

    note.change((d) => {
      d.title = "later";
    });
    view.route(note.url, { url: note.url, cloneUrl: pin() });
    await vi.waitFor(() => expect(handle.doc().title).toBe("later"));
    expect(snapshot.doc().title).toBe("note");
  });
});

describe("a swap", () => {
  it("keeps a cursor sub-handle on its cursors, not its indices", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "hello world" });
    const fork = repo.clone(note);
    fork.change((d) => {
      A.splice(d, ["text"], 0, 0, ">> ");
    });
    const view = mount(repo);
    const handle = await view.overlay.find<Note>(note.url);
    const range = handle.sub("text", cursor(6, 11));
    expect(range.doc()).toBe("world");

    view.route(note.url, { url: note.url, cloneUrl: fork.url });
    await backedBy(handle, fork);
    expect(range.doc()).toBe("world");
    expect(range.rangePositions()).toEqual([9, 14]);
  });

  it("goes through when a cursor sub-handle's path isn't text in the new backing", async () => {
    const scratch = getScratchRepo();
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "hello world" });
    const computed = scratch.create<{ title: string; text: number }>({
      title: "computed",
      text: 3,
    });
    const view = mount(repo);
    const handle = await view.overlay.find<Note>(note.url);
    handle.sub("text", cursor(0, 5));
    const changes: unknown[] = [];
    handle.on("change", (p) => changes.push(p.scopeReplaced));

    view.route(note.url, { url: note.url, scratchUrl: computed.url });
    await backedBy(handle, computed);
    expect(handle.doc().title).toBe("computed");
    expect(changes).toEqual([true]);
    expect(view.leases(computed.url)).toBe(1);
  });

  it("emits heads-changed then change, with whole documents in patchInfo, on every handle", async () => {
    const repo = new Repo();
    const note = repo.create({ nested: { x: 1 } });
    const fork = repo.clone(note);
    fork.change((d) => {
      d.nested.x = 2;
    });
    const view = mount(repo);
    const handle = await view.overlay.find<
      typeof note extends DocHandle<infer T> ? T : never
    >(note.url);
    const sub = handle.sub("nested");
    const log: string[] = [];
    for (const h of [handle, sub]) {
      h.on("heads-changed", (p) => {
        expect(p.handle).toBe(h);
        expect(A.getHeads(p.doc)).toEqual(A.getHeads(fork.doc()));
        log.push(`heads ${h.url}`);
      });
      h.on("change", (p) => {
        expect(p.handle).toBe(h);
        expect(p.scopeReplaced).toBe(true);
        expect(p.doc).toEqual(h.doc());
        expect(A.getHeads(p.patchInfo.before)).toEqual(A.getHeads(note.doc()));
        expect(A.getHeads(p.patchInfo.after)).toEqual(A.getHeads(fork.doc()));
        log.push(`change ${h.url}`);
      });
    }
    view.route(note.url, { url: note.url, cloneUrl: fork.url });
    await backedBy(handle, fork);
    expect(log).toEqual([
      `heads ${handle.url}`,
      `heads ${sub.url}`,
      `change ${handle.url}`,
      `change ${sub.url}`,
    ]);
    expect(sub.doc()).toEqual({ x: 2 });
    // Nothing is left listening on the old backing's sub-handle.
    expect(note.sub("nested").listenerCount("change")).toBe(0);
    expect(note.sub("nested").listenerCount("heads-changed")).toBe(0);
  });
});

const gc = (globalThis as { gc?: () => void }).gc;

describe.runIf(gc)("derived handles", () => {
  // Whether `ref`'s target has been collected. `deref()` keeps its target
  // alive to the end of the job it's called in, so each collection runs a
  // job after the last look; and it answers with a boolean, since an awaited
  // object can stay alive in the suspended caller's frame.
  async function collected(ref: WeakRef<object>): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      await settle();
      gc!();
      await settle();
      if (ref.deref() === undefined) return true;
    }
    return false;
  }

  it("aren't kept alive by the overlay once nothing holds or listens to them", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "hello world" });
    const view = mount(repo);
    const handle = await view.overlay.find<Note>(note.url);
    // One per selection, as the editors make them.
    const ref = (() => new WeakRef(handle.sub("text", cursor(1, 4))))();
    expect(await collected(ref)).toBe(true);
  });

  it("are kept alive while something listens, and let go after", async () => {
    const repo = new Repo();
    const note = repo.create<Note>({ title: "note", text: "hello world" });
    const view = mount(repo);
    const handle = await view.overlay.find<Note>(note.url);
    const listener = () => {};
    // Touched only in synchronous helpers, so this async frame never holds it.
    const ref = (() => {
      const sub = handle.sub("title");
      sub.on("change", listener);
      return new WeakRef(sub);
    })();
    expect(await collected(ref)).toBe(false);
    (() => ref.deref()!.off("change", listener))();
    expect(await collected(ref)).toBe(true);
  });
});
