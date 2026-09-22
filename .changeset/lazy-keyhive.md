---
"@inkandswitch/patchwork": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork-elements": patch
"@inkandswitch/patchwork-plugins": patch
---

`@automerge/automerge-repo-keyhive` is loaded only where keyhive is in use: `createRepo` and the automerge protocol handler worker `import()` it inside their keyhive branch, and `patchwork-elements` and `patchwork-plugins` no longer import it at runtime. Its entry module carries the keyhive wasm as a 3 MB base64 string, so the static imports put a 3.1 MB chunk in every tab's modulepreload list and in the worker whether or not the site enabled keyhive, at 7 to 10 MB of memory per tab, and 8 MB in the protocol-handler worker. The chunk is still emitted under `/packages/` and listed in the import map for tool code. Type imports are unchanged.

`isKeyhiveDoc` in `patchwork-plugins`, and the keyhive access gates in `patchwork-elements`, decide from the document id's bytes: an id shorter than 32 bytes, or one whose bytes 16 through 31 are all zero, is a legacy document. They used to construct a keyhive `DocumentId` and take a throw as legacy, but that constructor is an ed25519 point decode and accepts about half of legacy padded ids, so about half of legacy documents went through `bestAccessForDoc`. This is the check behind ARK's `isUnprotectedDoc`, which it recommends over the deprecated `docIdFromAutomergeUrl`.

When keyhive access to a document changes, `patchwork-elements` looks up the document's handle by its automerge document id before retrying. It used the keyhive `DocumentId` string, which is hex and never matched a handle, so an unavailable handle was never dropped before the retry.

The vite plugin gives the worker chunks an empty module-preload dependency list. Vite wraps a dynamic import in a preload helper that touches `document` when it has dependencies to preload, and a worker has no `document`.
