// Watching a document's heads without loading it. With the tab's backend (its
// port to the automerge worker) a bare session is opened and its
// `remote-heads` events are read; without one, the document is found in the
// Repo and its handle's `remote-heads` are heard.
import { describe, expect, it, vi } from "vitest";
import {
  Repo,
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import {
  sedimentreeId,
  type SedimentreeBackend,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree";

import { watchDocument, watchServerHeads } from "../src/watch-document.js";

const hex = (c: string) => c.repeat(64);

/** A backend whose sessions the test feeds `remote-heads` events by hand. */
function fakeBackend() {
  const opened: unknown[] = [];
  const sessions: Array<{
    closed: boolean;
    emit(event: unknown): void;
    fail(error: Error): void;
  }> = [];
  const backend = {
    open(id: unknown): SedimentreeSession {
      opened.push(id);
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      let error: Error | undefined;
      const control = {
        closed: false,
        emit(event: unknown) {
          queue.push(event);
          wake?.();
        },
        fail(e: Error) {
          error = e;
          wake?.();
        },
      };
      sessions.push(control);
      return {
        events: (async function* () {
          while (!control.closed) {
            if (error) throw error;
            if (queue.length) yield queue.shift() as never;
            else await new Promise<void>((r) => (wake = r));
          }
        })(),
        async close() {
          control.closed = true;
          wake?.();
        },
        publishEphemeral: async () => {},
        markReady() {},
      } as unknown as SedimentreeSession;
    },
  } as unknown as SedimentreeBackend;
  return { backend, opened, sessions };
}

const remoteHeads = (heads: string[], id = "server", sequence = 1) => ({
  type: "remote-heads",
  sequence,
  remote: { kind: "server", id, path: [] },
  heads,
});

describe("watchServerHeads", () => {
  it("opens a session on the document and reports the server's heads", async () => {
    const { backend, opened, sessions } = fakeBackend();
    const url =
      `automerge:${parseAutomergeUrl((await new Repo().create({})).url).documentId}` as AutomergeUrl;
    const { documentId, binaryDocumentId } = parseAutomergeUrl(url);
    const reports: Array<{ peerId: string; heads: string[] }> = [];

    const stop = watchServerHeads(backend, documentId, (report) =>
      reports.push(report)
    );
    expect(opened).toEqual([sedimentreeId(binaryDocumentId)]);

    sessions[0].emit(remoteHeads([hex("a"), hex("b")]));
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0].peerId).toBe("server");
    expect(reports[0].heads).toEqual([hex("a"), hex("b")]);
    stop();
  });

  it("ignores events that aren't remote heads", async () => {
    const { backend, sessions } = fakeBackend();
    const { documentId } = parseAutomergeUrl((await new Repo().create({})).url);
    const reports: unknown[] = [];
    const stop = watchServerHeads(backend, documentId, (r) => reports.push(r));

    sessions[0].emit({ type: "something-else" });
    sessions[0].emit(remoteHeads([hex("c")]));
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    stop();
  });

  it("closes its session and stops reporting once stopped", async () => {
    const { backend, sessions } = fakeBackend();
    const { documentId } = parseAutomergeUrl((await new Repo().create({})).url);
    const reports: unknown[] = [];
    const stop = watchServerHeads(backend, documentId, (r) => reports.push(r));

    stop();
    await vi.waitFor(() => expect(sessions[0].closed).toBe(true));
    sessions[0].emit(remoteHeads([hex("d")]));
    await new Promise((r) => setTimeout(r, 20));
    expect(reports).toEqual([]);
  });

  it("survives a session that errors", async () => {
    const { backend, sessions } = fakeBackend();
    const { documentId } = parseAutomergeUrl((await new Repo().create({})).url);
    const reports: unknown[] = [];
    const stop = watchServerHeads(backend, documentId, (r) => reports.push(r));

    sessions[0].fail(new Error("worker went away"));
    await new Promise((r) => setTimeout(r, 20));
    expect(reports).toEqual([]);
    stop();
  });
});

describe("watchDocument", () => {
  it("with a backend, summarizes the server's heads without loading the document", async () => {
    const { backend, sessions } = fakeBackend();
    const repo = new Repo();
    const handle = await repo.create({ count: 0 });
    const find = vi.spyOn(repo, "find");
    const heard: string[] = [];

    const stop = watchDocument({ repo, backend }, handle.url, (seen) =>
      heard.push(seen)
    );
    // The same heads in any order are the same `seen`.
    sessions[0].emit(remoteHeads([hex("b"), hex("a")], "server", 1));
    sessions[0].emit(remoteHeads([hex("a"), hex("b")], "server", 2));
    sessions[0].emit(remoteHeads([hex("c")], "server", 3));
    await vi.waitFor(() => expect(heard).toHaveLength(3));
    expect(heard[0]).toBe(heard[1]);
    expect(heard[2]).not.toBe(heard[0]);
    expect(find).not.toHaveBeenCalled();
    stop();
    await repo.shutdown();
  });

  it("without a backend, hears the handle's remote-heads", async () => {
    const repo = new Repo();
    const handle = await repo.create({ count: 0 });
    const heard: string[] = [];
    const stop = watchDocument({ repo }, handle.url, (seen) =>
      heard.push(seen)
    );
    await new Promise((r) => setTimeout(r, 0));

    (handle as any).emit("remote-heads", { heads: [hex("b"), hex("a")] });
    (handle as any).emit("remote-heads", { heads: [hex("c")] });
    expect(heard).toEqual([`${hex("a")}|${hex("b")}`, hex("c")]);

    stop();
    (handle as any).emit("remote-heads", { heads: [hex("d")] });
    expect(heard).toHaveLength(2);
    await repo.shutdown();
  });

  it("without a backend, doesn't throw for a document that can't be found", async () => {
    const repo = new Repo();
    const stop = watchDocument(
      { repo },
      "automerge:2uZrhZ7G2NJxryZSMWSdDNFCke8C" as AutomergeUrl,
      () => {}
    );
    stop();
    await repo.shutdown();
  });
});
