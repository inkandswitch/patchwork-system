# Draft preview overlay: the real fix for patchwork-next

This documents a workaround currently living in chitterchatter
(`src/lib/preview-frame.ts`, `DESCRIPTOR_LIFT_SHIM`) and the proper host-side fix
it should be replaced by.

## Symptom

When the chat is open on a **draft** and `@computer` builds/edits a tool, the
chat's own reads/writes correctly hit the draft clones — but the **pinned preview
iframe keeps showing Main's version** of the tool, never the drafted edits.

## Root cause

Document resolution is remappable via a bubbling `repo:handle-descriptor`
subscription:

- `element.repo` is an `OverlayRepo` (one per `<patchwork-view>`). On `find` it
  doesn't fork; it dispatches `repo:handle-descriptor` and uses the **nearest**
  answering ancestor's `{ url, cloneUrl? }`
  (`providers/core/src/overlay-repo.ts`).
- The **draft overlay provider** answers with a `cloneUrl` (→ read/write the
  clone).
- The root **`<repo-provider>`** is a deliberate *fallback* that answers
  `{ url }` with **no clone** (`providers/core/src/repo-provider.ts`). Its own
  doc comment says: *"A nearer remapper answers and `stopPropagation()`s first,
  so this only fires when nothing else claims the subscription."*

So correctness depends entirely on the draft overlay being **nearer** to the tool
than `repo-provider`.

The preview iframe self-bootstraps by wrapping `#root` with the overlay provider
(`overlay > #root`). Then the bootloader runs:

```js
// core/bootloader/src/site.ts  (bootPatchworkSite)
const repoProvider = document.createElement("repo-provider")
rootElement.parentElement.insertBefore(repoProvider, rootElement)
repoProvider.appendChild(rootElement)
```

This **unconditionally** makes `<repo-provider>` the *direct parent* of `#root`,
landing it **inside** our overlay wrapper. The chain becomes:

```
overlay-provider  >  repo-provider  >  #root  >  …tool view
```

`repo-provider` is now nearer than the overlay, intercepts every descriptor
request first, and answers "no clone" → the iframe resolves originals → shows
Main. The overlay provider is mounted and willing, but never gets the event.

You cannot fix this from the srcdoc by wrapping from the outside, because the
bootloader always re-parents `#root` with its own `repo-provider`.

## The proper fix (patchwork-next)

`repo-provider` is the *root fallback* and should be the **outermost** descriptor
answerer, never wedged between a nearer remapper and the tool. When inserting it,
walk past any pre-existing remapper wrapper(s) around `#root` and insert *above*
them, so a draft overlay (or any other remapper) stays nearer to the tool:

```js
// core/bootloader/src/site.ts — replacing the insertBefore(repoProvider, rootElement) block
const repoProvider = document.createElement("repo-provider")
let top = rootElement
// climb past wrappers that pre-exist around #root (e.g. a draft overlay provider)
while (top.parentElement && top.parentElement.tagName === "PATCHWORK-VIEW") {
  top = top.parentElement
}
top.parentElement.insertBefore(repoProvider, top)
repoProvider.appendChild(top)
// chain becomes:  repo-provider > overlay-provider > #root
```

Result: `repo-provider > overlay > #root`. The overlay is nearer → it answers and
`stopPropagation()`s; `repo-provider` only fires as the fallback when no overlay
is present. This is generic (no chitterchatter knowledge in the bootloader) and
matches the documented design intent.

In a normal (non-preview) host there is no wrapper around `#root`, so the loop is
a no-op and behavior is unchanged.

## Once that lands

Delete `DESCRIPTOR_LIFT_SHIM` and its injection from
`chitterchatter/src/lib/preview-frame.ts`; the plain `overlay > #root` wrap plus
shared `parent.repo` is then sufficient.
