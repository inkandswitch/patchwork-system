// Keyhive tabs syncing through the sync node: encrypted documents stored under
// the interceptor's prefix, pushed by the node as ciphertext, and decrypted by
// the tab they're forwarded to. There's no keyhive server here, so ARK's own
// keyhive sync never gets an answer; tabs share keyhive state the way they do
// in a browser, through the keyhive database.
import { afterEach, describe, expect, it } from "vitest";
import { Repo, type DocHandle } from "@automerge/automerge-repo";
import {
  initializeAutomergeRepoKeyhive,
  initKeyhiveWasm,
} from "@automerge/automerge-repo-keyhive";
import {
  MemorySigner,
  MemoryStorage,
  Subduction,
} from "@automerge/automerge-subduction";
import { INTERCEPTOR_PREFIX } from "@automerge/automerge-repo";

import { SyncNode } from "../src/sync-node.js";
import { PortSyncRemote, relayKeyhive } from "../src/sync-remote.js";
import { loadKeyhiveSigner } from "../src/signer.js";
import { MemoryAdapter, endpointTo, eventually, SERVICE } from "./harness.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((stop) => stop().catch(() => {})));
});

type Doc = { text?: string };

describe("sync node on a keyhive site", () => {
  it("pushes ciphertext and carries edits between tabs", async () => {
    initKeyhiveWasm();
    const server = {
      subduction: new Subduction({
        signer: MemorySigner.generate(),
        storage: new MemoryStorage(),
        serviceName: SERVICE,
      }),
      up: true,
    };
    const storage = new MemoryAdapter();
    const keyhiveStorage = new MemoryAdapter();
    let node: SyncNode | undefined;
    const connect = (port: MessagePort) => {
      void nodeReady.then((ready) => ready.connect(port));
    };
    let startNode!: () => void;
    const nodeReady = new Promise<SyncNode>((resolve) => {
      startNode = async () => {
        node = new SyncNode({
          signer: await loadKeyhiveSigner(keyhiveStorage),
          storage,
          storagePrefix: INTERCEPTOR_PREFIX,
          endpoints: [endpointTo(server)],
          log: () => {},
        });
        cleanup.push(() => node!.shutdown());
        resolve(node);
      };
    });

    const tab = async (name: string) => {
      const remote = new PortSyncRemote(() => {
        const { port1, port2 } = new MessageChannel();
        connect(port2);
        return port1;
      });
      const { hive, repo } = await initializeAutomergeRepoKeyhive({
        createRepo: (config) => relayKeyhive(new Repo(config), remote),
        storage: keyhiveStorage,
        peerIdSuffix: name,
        syncServer: "subduction",
        repo: {
          storage,
          subductionRemote: remote,
          headsChannel: `keyhive-test-heads`,
        },
      });
      cleanup.push(async () => {
        hive.close?.();
        await repo.shutdown();
      });
      return repo;
    };

    const a = await tab("a");
    // The node signs as the keyhive identity, which the first tab created.
    startNode();
    // `create2` is what mints a keyhive (protected, encrypted) document.
    const inA: DocHandle<Doc> = await a.create2<Doc>();
    inA.change((doc) => {
      doc.text = "secret";
    });
    await a.flush();

    // What reached the server is ciphertext.
    await eventually(async () => {
      const heads = await server.subduction.getAllHeads();
      return heads.length > 0;
    });
    const sids = await server.subduction.sedimentreeIds();
    const blobs = (await server.subduction.getBlobs(sids[0])) ?? [];
    expect(blobs.length).toBeGreaterThan(0);
    const plaintext = new TextEncoder().encode("secret");
    const contains = (haystack: Uint8Array) =>
      haystack.some((_, i) =>
        plaintext.every((byte, j) => haystack[i + j] === byte)
      );
    expect(blobs.some(contains)).toBe(false);

    // A second tab, booted after the first wrote its keyhive state.
    const b = await tab("b");
    const inB = await b.find<Doc>(inA.url);
    expect(inB.doc().text).toBe("secret");

    inA.change((doc) => {
      doc.text = "still secret";
    });
    await eventually(() => inB.doc().text === "still secret");
  });
});
