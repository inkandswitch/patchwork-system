// The hub's ARK 0.6 keyhive (keyhive 0.3) against the prod sync server. Prod
// has run keyhive_core 0.7 since 2026-10-26, which can't take the events
// keyhive 0.3 makes for new documents, so this covers what still works there:
// keyhive sync, sharing and making things public, and creating a document
// failing straight away. Talks to the network, so it only runs with
// PATCHWORK_NETWORK_TESTS=1.
import "@automerge/automerge";
import "@automerge/subduction";
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js";
import { describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub/hub.js";

const PROD = "wss://subduction.sync.inkandswitch.com";
const run = process.env.PATCHWORK_NETWORK_TESTS ? describe : describe.skip;

async function hub(): Promise<Hub> {
  const h = await createHub({
    syncServer: { url: PROD, keyhive: true, ark: "0.6" },
    storagePrefix: "test",
    stores: {
      kv: new DummySubductionStorageAdapter(),
      documents: new DummySubductionStorageAdapter(),
    },
  });
  await h.network.connected();
  await h.hive!.sync();
  return h;
}

run("hub keyhive (ARK 0.6) on prod", () => {
  it("syncs keyhive and shares, but won't create documents", async () => {
    const [a, b] = await Promise.all([hub(), hub()]);
    await a.hive!.setAccess(await b.hive!.contactCard(), "read");
    await a.hive!.setAccess("public", "read");
    const started = Date.now();
    await expect(a.repo.create({ n: 0 })).rejects.toThrow(
      /can't create keyhive documents/
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await Promise.all([a.close(), b.close()]);
  }, 60_000);
});
