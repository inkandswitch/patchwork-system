---
"@inkandswitch/patchwork": minor
---

Add `static` and `buildInfo` options to the vite plugin.

`static` mounts file trees into the site — a package of Patchwork modules, a
sibling repo's build output, a hand-written `modules.json`. Each source is
served by the dev server and copied into the site at build:

```js
patchwork({
  static: [
    { from: "modules.json" },
    "@inkandswitch/patchwork-pkg-base",
    {
      from: "../notebook/dist",
      to: "/packages/notebook",
      watch: ".watch-ready",
    },
  ],
});
```

A source is either a package specifier or a path relative to the site root, and
either a file or a directory. `to` mounts it somewhere other than the site root.
`watch` names a file inside the source that another build touches when it
finishes; writing to it full-reloads the dev page, which is how a sibling repo
in watch mode drives the site's dev server.

Sources never overwrite the site's own files — not the build's output, not
`public/`, not an earlier source in the list — so precedence is list order. A
site that wants its own `modules.json` lists it before the package it takes the
rest of its modules from. Every file a source didn't get to write is logged at
the end of the build, so a collision you didn't mean to have is visible.

A package can say which of its directories is the static tree with a
`"patchwork": {"static": "static-dist"}` field in its package.json. Without one,
the package root is mounted (minus its manifest, `node_modules` and `.git`).

`buildInfo` writes `build-info.json`: the site's git revision, the version and
revision of the patchwork that built it, and every `static` source. Pass an
object to merge extra fields into it.

Both options are off unless set, so existing sites are unaffected.
