---
"@inkandswitch/patchwork-filesystem": patch
---

A path can be read, and the files around it listed. `readPath(repo, path, options)` gives what a path names the way the service worker serves it (a file doc's content with its mime type, bytes as they are, anything else as JSON), with the path's pinned form. `listFiles(repo, pinnedPath, options)` gives every file under the last container a canonical pinned path enters, each keyed by its `tail` (the encoded names below the container) with the id of the document that holds its bytes. It lists into nested folders only when the container is a package, meaning it has a `package.json`, or when `deep` says so. A file that can't be read is named in `missing` rather than failing the list. `walkPath`'s result gains `container` (the last folder or directory entered, with its pinned path) and `tail`. `readNode` is exported for reading a value the same way.
