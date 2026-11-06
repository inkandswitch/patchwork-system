import { describe, expect, it, vi } from "vitest";
import {
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { addSyncServerRelay } from "@inkandswitch/patchwork-plugins";
import { relayNewDocs } from "../src/server-relay.js";

// a keyhive doc's id is 32 bytes, the second 16 not all zero
function keyhiveUrl(): AutomergeUrl {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  bytes[31] = 1;
  return stringifyAutomergeUrl(bytes as never);
}

// an ordinary automerge doc's id is 16 bytes
function plainUrl(): AutomergeUrl {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return stringifyAutomergeUrl(bytes as never);
}

function fakeHive() {
  return { addSyncServerRelayToDoc: vi.fn(async (_url: AutomergeUrl) => {}) };
}

function fakeRepo(url: () => AutomergeUrl) {
  const handles: Array<{ url: AutomergeUrl; update: ReturnType<typeof vi.fn> }> = [];
  const repo = {
    create2: vi.fn(async (_initial?: unknown) => {
      const handle = { url: url(), update: vi.fn() };
      handles.push(handle);
      return handle;
    }),
  };
  return { repo, handles };
}

describe("addSyncServerRelay", () => {
  it("adds the server to a keyhive doc once", async () => {
    const hive = fakeHive();
    const url = keyhiveUrl();
    expect(await addSyncServerRelay(hive, url)).toBe(true);
    expect(await addSyncServerRelay(hive, url)).toBe(false);
    expect(hive.addSyncServerRelayToDoc).toHaveBeenCalledTimes(1);
  });

  it("adds it once when two callers ask at the same time", async () => {
    const hive = fakeHive();
    const url = keyhiveUrl();
    const added = await Promise.all([
      addSyncServerRelay(hive, url),
      addSyncServerRelay(hive, url),
    ]);
    expect(added.filter(Boolean)).toHaveLength(1);
    expect(hive.addSyncServerRelayToDoc).toHaveBeenCalledTimes(1);
  });

  it("leaves a doc that isn't a keyhive doc alone", async () => {
    const hive = fakeHive();
    expect(await addSyncServerRelay(hive, plainUrl())).toBe(false);
    expect(hive.addSyncServerRelayToDoc).not.toHaveBeenCalled();
  });

  it("tries again after a failure", async () => {
    const hive = fakeHive();
    hive.addSyncServerRelayToDoc.mockRejectedValueOnce(new Error("offline"));
    const url = keyhiveUrl();
    await expect(addSyncServerRelay(hive, url)).rejects.toThrow("offline");
    expect(await addSyncServerRelay(hive, url)).toBe(true);
    expect(hive.addSyncServerRelayToDoc).toHaveBeenCalledTimes(2);
  });
});

describe("relayNewDocs", () => {
  it("makes the server a relay of every new keyhive doc", async () => {
    const hive = fakeHive();
    const { repo, handles } = fakeRepo(keyhiveUrl);
    relayNewDocs(repo as never, hive as never);
    await repo.create2();
    await repo.create2({ title: "with content" });
    expect(hive.addSyncServerRelayToDoc.mock.calls.map(([url]) => url)).toEqual(
      handles.map((handle) => handle.url)
    );
  });

  it("touches a doc made with content, once the server is its relay", async () => {
    const hive = fakeHive();
    const { repo, handles } = fakeRepo(keyhiveUrl);
    relayNewDocs(repo as never, hive as never);
    await repo.create2();
    await repo.create2({ title: "with content" });
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(handles[1].update).toHaveBeenCalledTimes(1);
  });

  it("hands the doc back when the relay can't be added", async () => {
    const hive = fakeHive();
    hive.addSyncServerRelayToDoc.mockRejectedValue(new Error("no sync server"));
    const { repo, handles } = fakeRepo(keyhiveUrl);
    relayNewDocs(repo as never, hive as never);
    const handle = await repo.create2({ title: "still mine" });
    expect(handle).toBe(handles[0]);
    expect(handles[0].update).not.toHaveBeenCalled();
  });

  it("leaves docs that aren't keyhive docs alone", async () => {
    const hive = fakeHive();
    const { repo, handles } = fakeRepo(plainUrl);
    relayNewDocs(repo as never, hive as never);
    await repo.create2({ title: "plain" });
    expect(hive.addSyncServerRelayToDoc).not.toHaveBeenCalled();
    expect(handles[0].update).not.toHaveBeenCalled();
  });
});
