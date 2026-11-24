// Conformance: an overlay handle should be indistinguishable from the real
// handle it's backed by, except that every url it reports (its own, its subs',
// its views') is in the presented document's id. Each case runs the same
// script against a real `DocHandle` and against the overlay and compares what
// a consumer can observe, in four worlds: an identity remap, a clone backing,
// a backing that's been swapped in, and a scratch backing. Peer traffic is
// the one exception: a scratch backing has no peers, so the overlay's are
// the stored document's.
import { next as A } from "@automerge/automerge";
import {
  Repo,
  cursor,
  generateAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
  type UrlHeads,
} from "@automerge/automerge-repo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getScratchRepo } from "../src/index.js";
import {
  backedBy,
  mount,
  rebase,
  settle,
  unmountAll,
  type Mounted,
} from "./harness.js";

type Note = {
  title: string;
  text: string;
  nested: { x: { y: number } };
  items: { id: string; v: number }[];
};

const initial = (): Note => ({
  title: "note",
  text: "hello world",
  nested: { x: { y: 1 } },
  items: [
    { id: "a", v: 1 },
    { id: "b", v: 2 },
  ],
});

type H = DocHandle<any>;

type Pair = {
  repo: Repo;
  view: Mounted;
  note: DocHandle<Note>;
  /** The handle the overlay should behave like. */
  real: DocHandle<Note>;
  /** The handle whose peer traffic the overlay's should be. */
  peers: DocHandle<Note>;
  /** The overlay's handle for `note.url`. */
  over: DocHandle<Note>;
  /** Where `real` lives. */
  realRepo: Repo;
  /** A real url in the presented space. */
  presented(url: AutomergeUrl): AutomergeUrl;
  findReal(url: AutomergeUrl): Promise<H>;
  findOver(url: AutomergeUrl): Promise<H>;
};

type World = { name: string; pinnedFinds: boolean; setup(): Promise<Pair> };

const scratch = getScratchRepo();

function pairOver(
  repo: Repo,
  view: Mounted,
  note: DocHandle<Note>,
  real: DocHandle<Note>,
  over: DocHandle<Note>,
  realRepo: Repo = repo,
  peers: DocHandle<Note> = real
): Pair {
  return {
    repo,
    view,
    note,
    real,
    peers,
    over,
    realRepo,
    presented: (url) => rebase(url, note.url),
    findReal: (url) => realRepo.find(url),
    findOver: (url) => view.overlay.find(rebase(url, note.url)),
  };
}

const worlds: World[] = [
  {
    name: "identity remap",
    pinnedFinds: true,
    async setup() {
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      const view = mount(repo);
      const over = await view.overlay.find<Note>(note.url);
      return pairOver(repo, view, note, note, over);
    },
  },
  {
    name: "clone backing",
    pinnedFinds: true,
    async setup() {
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      const clone = repo.clone(note);
      clone.change((d) => {
        d.title = "clone";
      });
      const view = mount(repo);
      view.route(note.url, { url: note.url, cloneUrl: clone.url });
      const over = await view.overlay.find<Note>(note.url);
      return pairOver(repo, view, note, clone, over);
    },
  },
  {
    name: "swapped backing",
    pinnedFinds: true,
    async setup() {
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      const first = repo.clone(note);
      const second = repo.clone(note);
      second.change((d) => {
        d.title = "second";
        d.nested.x.y = 7;
      });
      const view = mount(repo);
      view.route(note.url, { url: note.url, cloneUrl: first.url });
      const over = await view.overlay.find<Note>(note.url);
      // Derive a few handles on the first backing, so the swap re-bases them.
      over.sub("nested", "x");
      over.sub("text", cursor(0, 5));
      view.route(note.url, { url: note.url, cloneUrl: second.url });
      await backedBy(over, second);
      return pairOver(repo, view, note, second, over);
    },
  },
  {
    name: "scratch backing",
    // A pinned url is shown from the stored document, never the scratch one.
    pinnedFinds: false,
    async setup() {
      const repo = new Repo();
      const note = repo.create<Note>(initial());
      const laid = scratch.create<Note>();
      laid.update(() => A.clone(note.doc()));
      laid.change((d) => {
        d.title = "laid";
      });
      const view = mount(repo);
      view.route(note.url, { url: note.url, scratchUrl: laid.url });
      const over = await view.overlay.find<Note>(note.url);
      return pairOver(repo, view, note, laid, over, scratch, note);
    },
  },
];

// Every handle derived the same way from a root, so the two sides line up.
function family(root: H, old: UrlHeads): H[] {
  return [
    root,
    root.sub("title"),
    root.sub("nested"),
    root.sub("nested", "x"),
    root.sub("nested", "x", "y"),
    root.sub("items", 0),
    root.sub("items", { id: "b" }),
    root.sub("text", cursor(0, 5)),
    root.sub("text", cursor(3, 8)),
    root.sub("text", cursor(6, 9)),
    root.sub("missing"),
    root.sub("items", { id: "nope" }),
    root.view(old),
    root.view(old).sub("nested"),
    root.sub("nested").view(old),
  ];
}

// What a consumer can read off a handle, with urls mapped into one space.
function reading(h: H, map: (url: AutomergeUrl) => AutomergeUrl) {
  return {
    url: map(h.url),
    documentId: parseAutomergeUrl(map(h.url)).documentId,
    doc: h.doc(),
    fullHeads: A.getHeads(h.fullDoc()),
    heads: h.heads(),
    readOnly: h.isReadOnly(),
    ready: h.isReady(),
    deleted: h.isDeleted(),
    state: h.state,
    path: h.path.map((s: { prop: unknown }) => s.prop),
    hasRange: h.range !== undefined,
    positions: h.rangePositions(),
  };
}

type Recorded = {
  event: string;
  self: boolean;
  doc?: unknown;
  patches?: unknown;
  scopeReplaced?: boolean;
  before?: string[];
  after?: string[];
  data?: number[];
  senderId?: string;
  message?: unknown;
  storageId?: string;
  heads?: string[];
};

function record(h: H, events: string[]): Recorded[] {
  const log: Recorded[] = [];
  for (const event of events) {
    h.on(event as "change", (p: any) => {
      log.push({
        event,
        self: p?.handle === h,
        doc: p?.doc === undefined ? undefined : structuredClone(p.doc),
        patches: p?.patches,
        scopeReplaced: p?.scopeReplaced,
        before: p?.patchInfo && A.getHeads(p.patchInfo.before),
        after: p?.patchInfo && A.getHeads(p.patchInfo.after),
        data: p?.data && [...p.data],
        senderId: p?.senderId,
        message: p?.message,
        storageId: p?.storageId,
        heads: p?.heads,
      });
    });
  }
  return log;
}

for (const world of worlds) {
  describe(`conformance: ${world.name}`, () => {
    let p: Pair;
    let old: UrlHeads;
    // The same, on the handle with the overlay's peers.
    let peersOld: UrlHeads;
    beforeEach(async () => {
      p = await world.setup();
      old = p.real.heads();
      peersOld = p.peers.heads();
    });
    afterEach(unmountAll);

    const same = (url: AutomergeUrl) => url;

    it("reads the same, under the presented url", () => {
      const real = family(p.real, old).map((h) => reading(h, p.presented));
      const over = family(p.over, old).map((h) => reading(h, same));
      expect(over).toEqual(real);
      for (const r of over) expect(r.documentId).toBe(p.note.documentId);
    });

    it("keeps reading the same after changes", () => {
      p.real.change((d) => {
        d.title = "changed";
        d.nested.x.y = 99;
        A.splice(d, ["text"], 0, 0, ">> ");
        d.items.unshift({ id: "c", v: 0 });
      });
      const real = family(p.real, old).map((h) => reading(h, p.presented));
      const over = family(p.over, old).map((h) => reading(h, same));
      expect(over).toEqual(real);
    });

    it("canonicalizes handle identity the same way", async () => {
      const relations = async (
        root: H,
        find: (url: AutomergeUrl) => Promise<H>
      ) => {
        const fam = family(root, old);
        return [
          root.sub() === root,
          root.sub("nested") === root.sub("nested"),
          root.sub("nested").sub("x") === root.sub("nested", "x"),
          root.sub("nested").sub("x").sub("y") === fam[4],
          root.sub("text", cursor(0, 5)) === fam[7],
          root.view(old) === root.view(old),
          root.view(old).sub("nested") === root.sub("nested").view(old),
          fam[13] === fam[14],
          (await find(root.sub("nested", "x").url)) === fam[3],
          (await find(root.sub("items", { id: "b" }).url)) === fam[6],
          (await find(root.url)) === root,
          // Every pair in the family: distinct urls, distinct handles.
          ...fam.flatMap((a, i) => fam.map((b, j) => i < j && a === b)),
        ];
      };
      const real = await relations(p.real, (u) => p.findReal(u));
      const over = await relations(p.over, (u) => p.findOver(u));
      expect(over).toEqual(real);
    });

    it("compares handles the same way", () => {
      const matrix = (fam: H[]) =>
        fam.flatMap((a) =>
          fam.map((b) => [
            a.equals(b),
            a.contains(b),
            a.isChildOf(b),
            a.overlaps(b),
          ])
        );
      expect(matrix(family(p.over, old))).toEqual(matrix(family(p.real, old)));
    });

    it("equals a real handle with the same url, both ways round", () => {
      // `equals` is url equality, and the overlay's url is the presented one.
      expect(p.over.equals(p.note)).toBe(true);
      expect(p.note.equals(p.over)).toBe(true);
      expect(p.over.sub("nested").equals(p.note.sub("nested"))).toBe(true);
      expect(p.over.equals(p.real)).toBe(p.real === p.note);
    });

    it("diffs the same way, against heads and against handles", () => {
      p.real.change((d) => {
        d.title = "diffed";
        d.nested.x.y = 5;
      });
      const diffs = (root: H) => {
        const now = root.heads();
        return [
          root.diff(old),
          root.diff(old, now),
          root.diff(root.view(old)),
          root.sub("nested").diff(old),
          root.sub("nested").diff(root.sub("nested").view(old)),
        ];
      };
      expect(diffs(p.over)).toEqual(diffs(p.real));
    });

    it("rejects writes to a view the same way", () => {
      const attempt = (h: H) => {
        try {
          h.view(old).change((d: Note) => {
            d.title = "nope";
          });
          return "wrote";
        } catch {
          return "threw";
        }
      };
      expect(attempt(p.over)).toBe(attempt(p.real));
    });

    it("keeps listener books the same way", () => {
      // Only the script's own listeners count: a real handle also carries
      // the repo's (and, as a backing, the overlay's), and the real `off(ev)`
      // with no listener removes those too, where the overlay's can't reach
      // them.
      const script = (h: H) => {
        const out: unknown[] = [];
        const f = () => {};
        const g = () => {};
        const k = () => {};
        const theirs = new Set(
          [...h.eventNames()].flatMap((ev) => h.listeners(ev))
        );
        const ours = (ev: string) =>
          h.listeners(ev).filter((fn: unknown) => !theirs.has(fn));
        const snap = () =>
          out.push([
            ours("change").length,
            ours("delete").length,
            [...h.eventNames()].filter((ev) => ours(ev).length > 0).sort(),
          ]);
        out.push(h.on("change", f) === h);
        snap();
        h.on("change", f);
        snap();
        h.on("change", g);
        h.once("change", k);
        h.addListener("delete", f);
        snap();
        snap();
        h.off("change", g);
        snap();
        h.off("change");
        snap();
        h.on("change", f);
        h.removeListener("delete", f);
        snap();
        h.removeAllListeners("change");
        snap();
        return out;
      };
      const fam = (root: H) => [root, root.sub("nested"), root.view(old)];
      expect(fam(p.over).map(script)).toEqual(fam(p.real).map(script));
    });

    it("emits the same events on changes, re-stamped to the listening handle", () => {
      const events = ["change", "heads-changed"];
      const realLogs = family(p.real, old).map((h) => record(h, events));
      const overFam = family(p.over, old);
      const overLogs = overFam.map((h) => record(h, events));
      const steps: ((fam: H[]) => void)[] = [
        (f) =>
          f[0].change((d: Note) => {
            d.title = "renamed";
          }),
        (f) =>
          f[3].change((d: { y: number }) => {
            d.y = 2;
          }),
        (f) =>
          f[0].change((d: Note) => {
            d.nested = { x: { y: 3 } };
          }),
        (f) =>
          f[0].change((d: Note) => {
            d.items.unshift({ id: "c", v: 0 });
          }),
        (f) =>
          f[0].change((d: Note) => {
            A.splice(d, ["text"], 0, 0, ">> ");
          }),
        (f) => f[1].change("by sub"),
        (f) =>
          f[0].change((d: Note) => {
            d.items.splice(
              d.items.findIndex((i) => i.id === "b"),
              1
            );
          }),
      ];
      // Each step runs once, alternately through the overlay and the real
      // handles, and both sides' listeners hear it.
      const realFam = family(p.real, old);
      steps.forEach((step, i) => step(i % 2 ? realFam : overFam));
      expect(overLogs.map((log) => log.map((e) => e.self))).toEqual(
        realLogs.map((log) => log.map((e) => e.self))
      );
      expect(overLogs).toEqual(realLogs);
      expect(overLogs.flat().length).toBeGreaterThan(0);
    });

    it("emits outbound ephemeral messages the same way", () => {
      const realLogs = family(p.peers, peersOld).map((h) =>
        record(h, ["ephemeral-message-outbound"])
      );
      const overLogs = family(p.over, old).map((h) =>
        record(h, ["ephemeral-message-outbound"])
      );
      p.over.broadcast({ hello: 1 });
      p.over.sub("nested", "x").broadcast({ hello: 2 });
      p.peers.sub("nested").broadcast({ hello: 3 });
      expect(overLogs).toEqual(realLogs);
      expect(realLogs[0]).toHaveLength(3);
    });

    it("hears inbound ephemeral messages and remote heads the same way", () => {
      const events = ["ephemeral-message", "remote-heads"];
      const realLogs = family(p.peers, peersOld).map((h) => record(h, events));
      const overLogs = family(p.over, old).map((h) => record(h, events));
      const peer = "peer-1" as Parameters<H["_receiveInboundEphemeral"]>[0];
      p.peers._receiveInboundEphemeral(peer, { hello: 1 });
      p.peers.sub("items", 0)._receiveInboundEphemeral(peer, { hello: 2 });
      // As the repo's sync state tracker does: on the root handle alone.
      p.peers.emit("remote-heads", {
        storageId: "server" as never,
        heads: p.peers.heads(),
        timestamp: 1,
      });
      expect(overLogs).toEqual(realLogs);
      expect(realLogs[0]).toHaveLength(3);
      expect(realLogs[1]).toHaveLength(2);
    });

    it("answers sync info from the same document", () => {
      // Heads only the peers' document has: a scratch one isn't caught up.
      p.peers.change((d) => {
        d.title = "since";
      });
      const storageId = "server" as Parameters<H["getSyncInfo"]>[0];
      const info = { lastHeads: p.peers.heads(), lastSyncTimestamp: 1 };
      const remote = p.peers.heads();
      vi.spyOn(p.peers, "getSyncInfo").mockReturnValue(info);
      vi.spyOn(p.peers, "getRemoteHeads").mockReturnValue(remote);
      expect(p.over.getSyncInfo(storageId)).toBe(info);
      expect(p.over.getRemoteHeads(storageId)).toBe(remote);
      expect(p.over.isCaughtUpWith(storageId)).toBe(true);
      expect(p.peers.isCaughtUpWith(storageId)).toBe(true);
    });

    it("tells every listening handle about a delete", async () => {
      const realLogs = family(p.real, old).map((h) => record(h, ["delete"]));
      const overLogs = family(p.over, old).map((h) => record(h, ["delete"]));
      p.realRepo.delete(p.real.url);
      expect(overLogs).toEqual(realLogs);
      expect(realLogs[0]).toHaveLength(1);
    });

    it("finds urls with paths the same way", async () => {
      const urls = [
        p.real.sub("nested", "x").url,
        p.real.sub("items", { id: "b" }).url,
        p.real.sub("text", cursor(2, 4)).url,
        p.real.sub("missing").url,
      ];
      const real = await Promise.all(
        urls.map(async (u) => reading(await p.findReal(u), p.presented))
      );
      const over = await Promise.all(
        urls.map(async (u) => reading(await p.findOver(u), same))
      );
      expect(over).toEqual(real);
    });

    it.runIf(world.pinnedFinds)(
      "finds urls pinned to heads the same way",
      async () => {
        p.real.change((d) => {
          d.title = "later";
        });
        const urls = [p.real.view(old).url, p.real.view(old).sub("nested").url];
        const real = await Promise.all(
          urls.map(async (u) => reading(await p.findReal(u), p.presented))
        );
        const over = await Promise.all(
          urls.map(async (u) => reading(await p.findOver(u), same))
        );
        expect(over).toEqual(real);
      }
    );

    it("lists the root handle under its documentId", async () => {
      await p.findOver(p.real.sub("nested", "x").url);
      if (world.pinnedFinds) await p.findOver(p.real.view(old).url);
      const listed = p.view.overlay.handles[p.note.documentId];
      expect(listed).toBe(p.over);
      expect(listed.url).toBe(p.note.url);
    });
  });
}

describe("conformance: finding", () => {
  afterEach(unmountAll);

  // States after the first `loading`: an overlay always starts `loading`, for
  // the descriptor's round trip, where a real repo may start `ready`.
  const settled = (states: string[]) => {
    const kept = states.filter((s) => s !== "loading");
    return kept.filter((s, i) => s !== kept[i - 1]);
  };

  it("reports a missing document unavailable, then ready once it arrives", async () => {
    const repo = new Repo();
    const view = mount(repo);
    const url = generateAutomergeUrl();
    const seen = { real: [] as string[], over: [] as string[] };
    const real = repo.findWithProgress(url);
    const over = view.overlay.findWithProgress(url);
    real.subscribe((s) => seen.real.push(s.state));
    over.subscribe((s) => seen.over.push(s.state));

    await expect(repo.find(url)).rejects.toThrow(/unavailable/);
    await expect(view.overlay.find(url)).rejects.toThrow(/unavailable/);
    expect(over.peek().state).toBe("unavailable");

    repo.import(A.save(A.from({ arrived: true })), {
      docId: parseAutomergeUrl(url).documentId,
    });
    expect(real.peek().state).toBe("ready");
    // The overlay retries by itself, a descriptor round trip later.
    await vi.waitFor(() => expect(over.peek().state).toBe("ready"));
    const state = over.peek() as QueryState<unknown> & { state: "ready" };
    expect(state.state).toBe("ready");
    expect(state.handle.url).toBe(url);
    expect(state.handle.doc()).toEqual({ arrived: true });
    expect(settled(seen.over)).toEqual(settled(seen.real));
    expect(settled(seen.over)).toEqual(["unavailable", "ready"]);
    expect(await over.whenReady()).toBe(state.handle);
    expect(await view.overlay.find(url)).toBe(state.handle);
  });

  it("doesn't call a subscriber until something changes", async () => {
    const repo = new Repo();
    const note = repo.create({ a: 1 });
    const view = mount(repo);
    await view.overlay.find(note.url);
    const calls = { real: 0, over: 0 };
    repo.findWithProgress(note.url).subscribe(() => calls.real++);
    view.overlay.findWithProgress(note.url).subscribe(() => calls.over++);
    await settle(10);
    expect(calls).toEqual({ real: 0, over: 0 });
  });

  it("rejects an aborted find with the signal's reason", async () => {
    const repo = new Repo();
    const note = repo.create({ a: 1 });
    const view = mount(repo);
    const reason = new Error("gave up");
    await expect(
      repo.find(note.url, { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    await expect(
      view.overlay.find(note.url, { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);

    // Heads the document doesn't have yet keep both finds waiting.
    const elsewhere = new Repo().import<{ a: number }>(A.save(note.doc()));
    elsewhere.change((d) => {
      d.a = 2;
    });
    const future = stringifyAutomergeUrl({
      documentId: note.documentId,
      heads: elsewhere.heads(),
    });
    const real = new AbortController();
    const over = new AbortController();
    const finds = [
      expect(repo.find(future, { signal: real.signal })).rejects.toBe(reason),
      expect(view.overlay.find(future, { signal: over.signal })).rejects.toBe(
        reason
      ),
    ];
    await settle(10);
    real.abort(reason);
    over.abort(reason);
    await Promise.all(finds);
  });
});
