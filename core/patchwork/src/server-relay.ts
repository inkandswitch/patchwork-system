import * as Automerge from "@automerge/automerge/slim";
import type { Repo } from "@automerge/automerge-repo/slim";
import type { AutomergeRepoKeyhiveBase as AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { addSyncServerRelay } from "@inkandswitch/patchwork-plugins";
import debug from "debug";

const log = debug("patchwork:setup:server-relay");

/**
 * Make every keyhive doc `repo.create2` makes one the sync server is a relay
 * of. The server keeps and hands out only those, so before this a doc made
 * with a plain `create2` (a chat message, a tldraw file, a seeded example)
 * never left the device that made it, and sharing it gave access to nothing.
 * `patchwork.create` and the account did it themselves; this covers the rest.
 *
 * A doc made with content has its first commit before the server could take
 * it, so it's touched once the server is a relay, to have that sent too. A
 * relay that can't be added (no sync server, a doc keyhive doesn't protect) is
 * logged, and the doc is still handed back.
 */
export function relayNewDocs(repo: Repo, hive: AutomergeRepoKeyhive): void {
  const create2 = repo.create2.bind(repo);
  repo.create2 = (async (initialValue?: unknown) => {
    const handle = await create2<unknown>(initialValue);
    try {
      const added = await addSyncServerRelay(hive, handle.url);
      if (added && initialValue !== undefined) {
        handle.update((doc) => Automerge.emptyChange(doc));
      }
    } catch (error) {
      log("couldn't make the sync server a relay of %s: %O", handle.url, error);
    }
    return handle;
  }) as Repo["create2"];
}
