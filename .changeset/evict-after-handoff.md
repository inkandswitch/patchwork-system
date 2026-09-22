---
"@inkandswitch/patchwork-bootloader": patch
---

The automerge protocol handler worker evicts the documents its Repo loaded once no `automerge:` handoff has been in flight for five seconds. A page load is a burst of handoffs through the same folder documents; they now stay hot across the load and are released after it, instead of living in the SharedWorker for as long as any tab is open. A headless `automerge:<folder>/path` redirect waits up to three seconds for the folder to hold every head a connected Subduction peer has advertised, since a re-found folder comes back from IndexedDB before its sync round lands.

Eviction goes through `Repo.removeFromCache`, which this workspace's pnpm patch of `@automerge/automerge-repo@2.6.0-subduction.48` makes real: `removeFromCache` awaits each source's `detach`, and the Subduction source's `detach` persists unsaved commits, runs one sync round if no peer has them, drops its entry and `heads-changed` listener, and unsubscribes the ephemeral topic, so the document can be collected and a later `find` attaches afresh. On the unpatched fork `detach` is a no-op: nothing is freed and a re-found document keeps a stale entry and stops syncing. Consumers installing from npm need that change upstream first.
