---
"@inkandswitch/patchwork-elements": minor
"@inkandswitch/patchwork-providers": patch
---

`<patchwork-view>` no longer mounts a tool or component after it has been removed. Before this change, a `tool-id` or `url` change, a hot reload or a keyhive access change that finished after a disconnect could start the view again on the detached element, and nothing ever tore it down. The leftover tool held a disposed handle, and its registry and keyhive listeners stayed registered forever. A keyed reorder could leave two copies mounted. Attributes set on a detached element no longer mount it either; it mounts on insertion. A render queued just before a teardown no longer lands during that teardown, which used to drop the tool's cleanup.

A failed suggested-package import now replaces the loading pulse with the error and offers to try again. Before, the error appeared next to a pulse that never stopped, and the package was never offered again.

When a doc fails to load, a keyhive op now retries the load in place. Before, it tore down the view and rebuilt it, so a busy connection kept blanking the error. A failed load is also tried again on a timer, after 1, 2, 4, 8 and 15 seconds: the op that grants access can land before the doc can be fetched and be the last op for a while, which left a doc someone had just shared showing "unavailable" until a reload. The `#clearDocCache` step that ran before each retry is gone: it could never find the handle it was looking for. In `@inkandswitch/patchwork-providers`, `OverlayRepo` now releases the `repo:handle-descriptor` subscription of a failed resolution. It used to leak one per retry, out of reach of `dispose`.

Keyhive access is now watched with one `ingest-remote` listener per hive instead of one per view. A burst of ops is checked once per doc, however many views show that doc. Views of legacy (non-keyhive) docs no longer listen at all.

The "load this package?" prompt now shows the parsed URL and the host it comes from. Before, it showed the raw string the document supplied, so a document could pad it with line breaks and fake reassurance. An `automerge:` suggestion that contains whitespace or invisible characters isn't offered.

`@automerge/automerge-repo-keyhive` is now listed as an optional peer dependency. The published types reference it through the `hive` option.

The `<patchwork-view>` JSX intrinsic has moved out of the main entry point. Before, importing the package added both the React and Solid typings, which broke type-checking for consumers without one of them installed (unless `skipLibCheck` was on). Opt in to the one you use:

```ts
import type {} from "@inkandswitch/patchwork-elements/react";
// or
import type {} from "@inkandswitch/patchwork-elements/solid";
```

The attribute type itself is exported from the main entry as `PatchworkViewAttrs`.
