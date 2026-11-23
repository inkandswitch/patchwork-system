# `<patchwork-editor>`

A new element, and two new plugin types. It lives alongside
`<patchwork-view>` (`core/elements/src/patchwork-view.ts`), which stays as it
is.

An editor shows an automerge doc with a tool, as a view does. What's
different:

1. it takes its repo from the closest `<patchwork-editor>` around it, before
   the one it was given
2. its `.repo` is an automerge-repo 3 repo
3. it reflects its doc's and its tool's properties onto itself, as attributes
4. it has an **ink space**: a way to say what's under a point in it, that
   someone else can find in theirs

## Plugin types

- **`patchwork:editor`**: what an editor shows a doc with.
- **a second type, for standalone views**: something shown on its own, not
  of a doc. Its name isn't settled.

Leanings, not decided yet:

- **Render returns an element**, rather than rendering into an element it's
  handed. The editor then puts that element where it goes.
- **It renders inside a shadow root.** Outside CSS then can't reach into a
  tool. Custom properties still inherit through the shadow boundary, so
  tools should be themed with tokens, as the file tool's tooltips now are.
  Embedders that restyle a tool's insides with selectors (knitfold hiding
  the file tool's gutter, say) need another way: tokens, `::part`, or an
  option.

## 1. The closest editor's repo

An editor uses the `.repo` of the closest `<patchwork-editor>` it's inside,
and only uses the repo it was registered with when there isn't one.

So whatever sets an editor's `.repo` decides the repo for everything inside
it. The tools inside don't need to know about it.

- "Closest" has to cross shadow roots, and with editors rendering in shadow
  roots that's the usual case. `closest()` stops at a shadow root, so the
  lookup walks up through `getRootNode().host`.
- The repo is looked up when the editor connects. If the editor is moved
  under a different editor, it looks again.

### Use it as it is, no overlay of its own

Each `<patchwork-view>` wraps the base repo in an `OverlayRepo` of its own,
which asks up the tree (`repo:handle-descriptor`) where each doc should
really be read from. An editor doesn't do this: it uses the outer editor's
repo as it is. Anything that wants to change how docs resolve for a subtree
sets `.repo` to a repo that does it.

Strand's drafts (`inkandswitch/strand.gaios.sgai.uk`,
`packages/drafts/src/draft-repo.ts` and `providers/DraftProvider.ts`), show
the shape:

- **It's a wrapper, not a copy.** `DraftRepo` is a proxy over the base repo.
  It owns only what it changes (`find`, `findWithProgress`, `create`, its
  own draft methods) and passes everything else through.
- **Handles keep their url.** A handle keeps the url it was asked for, but
  reads and writes the checked-out draft's clone. The clone is made on the
  first write, so a draft owns only the docs it changed.
- **Switching re-points handles in place.** A checkout re-points every live
  handle, so nothing remounts.
- **It never stacks on itself.** It always wraps `baseRepo(inherited)`, which
  unwraps any `DraftRepo` underneath. The drafts code itself always reads
  the base.

The drafts provider also answers `repo:handle-descriptor`, but only so the
`<patchwork-view>`s beneath it (which ignore an ancestor's `.repo`) land on
the draft too. Editors that take the closest editor's repo don't need that
round trip.

## 2. automerge-repo 3

An editor's `.repo` is an automerge-repo 3 repo. Anything that sets one for
a subtree, like a drafts repo, is one too.

## 3. The doc and tool, as attributes

The editor reflects its doc's and its tool's properties onto itself as
attributes, so they can be read from outside without asking the editor:
selected in CSS, found with `querySelector`, seen in devtools. They also let
an [ink space](#4-ink-space) anchor into a nested editor check that it's
still the same doc before placing anything.

Which ones comes later. Candidates are the doc's url and `@patchwork.type`,
and the tool's `id` (the one picked, if it fell back) and `name`.

## 4. Ink space

A point on someone's screen means nothing to anyone else. Their window isn't
the size of yours, and their copy of the doc isn't scrolled or zoomed the way
yours is. To show someone else's mouse, or a stroke they drew over the doc, in
the right place on your screen, you need to send what they were pointing at,
not where it was on their page.

An ink space is how an editor says that. Lattice's window manager and
knitfold both do this already, each in their own way:
- lattice: `packages/wm/anchor.js`, used by its ink strokes (`ink.js`) and
  its pointers
- knitfold: `packages/knitfold/src/anchor.ts`, used by its mice

`<patchwork-editor>` would make it something every editor has.

### The contract

An element can have `inkSpace`:

```ts
interface InkSpace {
	/** what's at (x, y) (client px), as something small and plain (json), or null for nothing */
	at(x: number, y: number): Json | null
	/**
	 * where that is on the page now, and how many page px a unit of the
	 * space is there; or null if it isn't to be seen (scrolled away, in
	 * another view, filtered out)
	 */
	place(at: Json): {x: number; y: number; scale: number} | null
}
```

A tool that knows its own layout sets this on its element (if render returns
an element, on that one). Lattice's skitch, 3d knit, animation and knitout
visualizer do, and so does knitfold's scarf. Their spaces are things like
"stitch 12 of row 4" or "this point in the model", which hold steady however
the tool is zoomed or panned. `scale` lets an offset from the anchor grow and
shrink with the zoom.

### What an editor does by default

When the tool hasn't given an ink space, the editor gives one, trying these
in order:

1. **a nested editor**: if the point is inside a `<patchwork-editor>` inside
   this one, ask that editor. The anchor is the path to that editor (checked
   against its doc's url when placing) plus that editor's own anchor. So ink
   spaces nest: "knitfold → this block's code → character 412". The path
   goes through shadow roots, as the repo lookup does.
2. **text**: a character in a CodeMirror editor (`posAtCoords` to anchor,
   `coordsAtPos` to place), so it stays on that character however each
   person has scrolled. The file tool should provide this itself. With the
   tool in a shadow root, nobody else could reach its `.cm-editor` anyway.
3. **an element**: the deepest element under the point, by child indices,
   and where in it as fractions (of what it scrolls, if it scrolls).
4. **the editor**: a place in the editor's box, as fractions of it.

A tool's own ink space wins over all of these.

### Rules

- What `at` gives goes to other people, so it should be small and plain. What
  comes back from them is untrusted: it's checked before it's placed, and
  thrown away if it doesn't check out.
- `at` and `place` can throw, and the editor carries on if they do. A broken
  ink space means the pointer falls back to the next default, not that the
  pointer is lost.
- `place` returns null when the thing isn't to be seen here. The pointer, or
  the ink, is then hidden, not pinned to an edge.

### Who uses it

Ink space only says where things are. Sending them belongs to presence. Mice
would be a channel in base's `doc-presence`, which already has a `Presence`
session for each doc and each person's name and colour. Ink strokes, pinned
comments and follow mode would use the same anchors.

Mice should travel on the presence of the outermost doc people are looking
at together, with the anchor path going down into the editors inside it.
Someone with the same nested doc open inside a different host has a
different layout, so their mice shouldn't land in yours.

## Open questions

- What's the standalone-view plugin type called?
- Does render return an element, or render into one it's handed?
- With tools in shadow roots, how do embedders adjust a tool's insides
  beyond tokens: `::part`, options on the editor, or both?
- Can something that isn't an editor (a provider, as the drafts one is
  today) set the `.repo` that editors beneath it inherit? Or does it have to
  be an editor, or a third kind of element?
