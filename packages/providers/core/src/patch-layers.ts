import { next as A } from "@automerge/automerge/slim";
import type {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
  Repo,
  UrlHeads,
} from "@automerge/automerge-repo/slim";

/**
 * Patch layers: a document that lives in one place and changes another,
 * without writing on it. After ermine's patch nodes.
 *
 * A patch doc names its target (`on`), the target's heads when it was made
 * (`at`), and a list of entries. Each entry changes one place:
 *
 * - a {@link PathPatch} puts a value at a path, or (no `value`) removes what's
 *   there;
 * - a {@link TextPatch} replaces a run of a string, or inserts into it;
 * - a {@link MarkPatch} puts a mark (bold, a link, a comment) on a run of a
 *   string, or (`value: null`) takes one off.
 *
 * Text and mark entries hold their run by Automerge cursors into the target,
 * not by index, so they move with the target's edits around them the way a
 * collaborator's cursor does. An entry may carry its own `at`, the heads its
 * cursors and values were taken against; otherwise the patch's `at` counts.
 *
 * A patch counts only while something loads it: kept in your own folder, only
 * you see it; kept in a shared folder, everyone who has the folder does.
 *
 * {@link LayeredDoc} lays patch docs over a live document. What it shows is
 * the target with every patch applied, back layer first, so the front layer
 * wins. The target can keep changing underneath: those changes show through
 * everywhere except where a patch decides, where the patch keeps winning.
 *
 * Writes go where they'd be seen. A write at or under a patched path, or
 * inside (or touching) a patched run of text, lands in the patch that shows
 * there (copy-up, like a union mount), so the user's edit isn't hidden by the
 * patch it was made through. Every other write goes to the target, unless a
 * laid patch is recording (`record: true`): then it goes into that patch, at
 * the smallest path it touched, or as a text entry for the run it changed.
 *
 * Paths are plain key paths, so a value patch through a list index follows
 * the index, not the item: an insert before it shifts what the patch lands on.
 */
export type PathPatch = {
  path: A.Prop[];
  value?: unknown;
  at?: UrlHeads;
};

/**
 * Replace the run of the string at `path` from the character `from` points at
 * through the one `to` points at with `insert`. Without `to` it replaces
 * nothing and inserts before `from`'s character (an `"end"` cursor: at the
 * end).
 *
 * `around` holds the characters either side of the run. When the target
 * deletes the run's own first or last character (someone retyped the words
 * the patch replaces), the run reaches out to its neighbour instead, so the
 * patch goes on replacing whatever now sits in that place.
 *
 * `over` names entries (by id) in patches behind this one that it was made
 * over: recording an edit to text another patch adds. They aren't shown while
 * this one is, so that text doesn't show twice.
 */
export type TextPatch = {
  path: A.Prop[];
  text: {
    from: A.Cursor;
    to?: A.Cursor;
    around?: [A.Cursor, A.Cursor];
    insert: string;
    /** Names the entry, so marks can be put on the text it adds. */
    id?: string;
    over?: string[];
  };
  at?: UrlHeads;
};

/**
 * Mark a run of the string at `path`; `value: null` unmarks it. The run is
 * either the target's own text, `from` through `to` (inclusive, cursors), or
 * text a text entry adds: `start`..`end` of the `insert` of the entry whose id
 * is `within` (in this patch or another laid one). Offsets into added text
 * move as that text is edited.
 */
export type MarkPatch = {
  path: A.Prop[];
  mark: {
    name: string;
    value: A.MarkValue | null;
    from?: A.Cursor;
    to?: A.Cursor;
    within?: string;
    start?: number;
    end?: number;
  };
  at?: UrlHeads;
};

export type PatchEntry = PathPatch | TextPatch | MarkPatch;

export type PatchDoc = {
  "@patchwork": { type: "patch" };
  on: AutomergeUrl;
  at: UrlHeads;
  patches: PatchEntry[];
  // While set (and the patch is laid), writes that would go to the target go
  // into this patch instead.
  record?: boolean;
  // Set by `landPatch`; the patches are on the target for real and the list
  // is empty.
  landedAt?: UrlHeads;
};

export function isTextPatch(entry: PatchEntry): entry is TextPatch {
  return "text" in entry && !!entry.text;
}

export function isMarkPatch(entry: PatchEntry): entry is MarkPatch {
  return "mark" in entry && !!entry.mark;
}

export function isPathPatch(entry: PatchEntry): entry is PathPatch {
  return !isTextPatch(entry) && !isMarkPatch(entry);
}

/**
 * A run of a patched string that a patch decides, in the string's own
 * positions as shown: what to highlight in an editor showing it.
 */
export type PatchHighlight = {
  start: number;
  end: number;
  /** The patch doc that decides it. */
  patch: AutomergeUrl;
  /** What the target has there instead, when it's a run of text. */
  replaced?: string;
  /** The whole string is the patch's (a value patch on or above it). */
  whole?: true;
  /** A text entry's run: where it is in the patch, its id, and the run of
   * the target's text it replaces. */
  index?: number;
  id?: string;
  base?: { start: number; end: number };
};

/**
 * What patches decide in the string at `path` of a handle, as shown: for an
 * editor to highlight. Follows a handle that's an overlay (or a view of one)
 * down to the layered doc that lays the patches. Empty when nothing's laid.
 */
export function patchHighlights(
  handle: unknown,
  path: readonly A.Prop[]
): PatchHighlight[] {
  let at = handle as { backingHandle?: unknown; documentId?: string } | undefined;
  for (let depth = 0; at && depth < 64; depth++) {
    while (at?.backingHandle) at = at.backingHandle as typeof at;
    const layered = at?.documentId ? layeredDocs.get(at.documentId) : undefined;
    if (!layered) return [];
    // One that lays nothing itself shows what's under it, position for
    // position.
    if (layered.laid().length > 0) return layered.highlights(path);
    at = layered.base as typeof at;
  }
  return [];
}

/** One layer of what a path shows, front first; the target's own is last. */
export type Layer = {
  from: AutomergeUrl | "base";
  value?: unknown;
  // The target's value at this path has changed since the patch was made.
  // Still applied.
  stale?: true;
  // The patch couldn't be applied (its parent isn't there); it's set aside.
  error?: string;
};

// One value patch, as laid: which layer it came from and where in its list.
type Cover = {
  layer: DocHandle<PatchDoc>;
  index: number;
  path: readonly A.Prop[];
  removes: boolean;
  value?: unknown;
};

// One text or mark entry, as laid. `order` counts from the back.
type TextCover = {
  layer: DocHandle<PatchDoc>;
  index: number;
  order: number;
  from: A.Cursor;
  to?: A.Cursor;
  around?: [A.Cursor, A.Cursor];
  insert: string;
  id?: string;
  over?: string[];
};
type MarkCover = {
  layer: DocHandle<PatchDoc>;
  index: number;
  order: number;
} & MarkPatch["mark"];

// Every text and mark entry on one string.
type TextGroup = {
  path: readonly A.Prop[];
  texts: TextCover[];
  marks: MarkCover[];
};

// A text entry as shown: the run it replaces in the target (`bs`..`be`) and
// the run it shows in the overlay (`os`..`oe`).
type Span = {
  cover: TextCover;
  bs: number;
  be: number;
  os: number;
  oe: number;
};

type Rendered = { text: string; spans: Span[] };

type ShownMark = { name: string; value: A.MarkValue; start: number; end: number };

// Patches being landed, and the overlays laying them that are waiting for
// it to finish before they lay again.
const landing = new Set<AutomergeUrl>();
const waiting = new Map<object, () => void>();

// Every live layered doc, by its overlay doc's id, so one laid over another's
// overlay (a nested view's base is its parent view's overlay) can see which
// patches are already showing underneath it.
const layeredDocs = new Map<string, LayeredDoc<unknown>>();

/**
 * The patch docs a handle already shows, front first: those of the layered
 * doc behind it, if any, and of whatever that one is laid over.
 */
function layersShownBy(handle: unknown): Set<AutomergeUrl> {
  const shown = new Set<AutomergeUrl>();
  let at = handle as { backingHandle?: unknown; documentId?: string } | undefined;
  for (let depth = 0; at && depth < 64; depth++) {
    while (at?.backingHandle) at = at.backingHandle as typeof at;
    const layered = at?.documentId ? layeredDocs.get(at.documentId) : undefined;
    if (!layered) break;
    for (const url of layered.laid()) shown.add(url);
    at = layered.base as typeof at;
  }
  return shown;
}

/**
 * A live document with patch docs laid over it, presented as an ordinary
 * `DocHandle` (`handle`) living in an in-memory repo of its own: nothing it
 * holds is saved or synced, and tools get the whole handle surface
 * (`sub`, `view`, change events, heads) for free.
 *
 * The overlay doc and the target are kept in step by patches, not by shared
 * history: the target's changes are replayed onto it, and its own writes are
 * replayed onto the target. Everywhere no patch covers, the two hold the same
 * value, so positions in a patch mean the same on both sides. Its history is
 * therefore its own: `history()` and `view(heads)` on `handle` don't describe
 * the target's past.
 */
export class LayeredDoc<T> {
  readonly base: DocHandle<T>;
  /** Front first. */
  readonly layers: readonly DocHandle<PatchDoc>[];
  readonly handle: DocHandle<T>;

  // The layers this one lays: those the base doesn't already show.
  #laid: DocHandle<PatchDoc>[] = [];
  // In apply order: back layer first, each layer's patches in list order.
  #covers: Cover[] = [];
  // Lists with a patch on one of their indexes, by path key. Those are
  // worked out whole from the target's list each time, so a patch removing
  // an item removes one item however often it's laid, and the target's
  // inserts and deletes keep the list in step.
  #lists = new Map<string, A.Prop[]>();
  #groups = new Map<string, TextGroup>();
  // What each patched string shows now, by path key.
  readonly #rendered = new Map<string, Rendered>();
  readonly #errors = new Map<Cover, string>();
  // Set while this class writes to `handle` / `base`, so the change events
  // those writes raise aren't mistaken for a tool's write or the target's.
  #applying = false;
  #routing = false;
  // Set while this class writes to the patch docs: their change events wait
  // until it's done, so a half-made edit is never laid.
  #holding = 0;
  #layerPending = false;
  readonly #offs: (() => void)[] = [];
  #disposed = false;

  constructor(
    base: DocHandle<T>,
    layers: readonly DocHandle<PatchDoc>[],
    scratch: Repo
  ) {
    this.base = base;
    this.layers = layers;
    this.handle = scratch.create<T>();
    layeredDocs.set(this.handle.documentId, this as LayeredDoc<unknown>);
    this.#apply(() => this.handle.update(() => A.clone(base.fullDoc())));
    this.#collect();
    this.#assert();

    this.#listen(base, (payload) => this.#onBase(payload));
    for (const layer of layers) this.#listen(layer, () => this.#onLayer());
    this.#listen(this.handle, (payload) => this.#onWrite(payload));
  }

  /** What `path` shows, layer by layer, front first. */
  describe(path: readonly A.Prop[]): Layer[] {
    const out: Layer[] = [];
    for (let i = this.#covers.length - 1; i >= 0; i--) {
      const cover = this.#covers[i];
      if (!isPrefix(cover.path, path)) continue;
      const layer: Layer = { from: cover.layer.url };
      const rest = path.slice(cover.path.length);
      if (!cover.removes) {
        const value = getAt(cover.value, rest);
        if (value !== undefined) layer.value = value;
      }
      const entry = cover.layer.doc()?.patches[cover.index];
      if (entry && isEntryStale(this.base, cover.layer.doc(), entry)) {
        layer.stale = true;
      }
      const error = this.#errors.get(cover);
      if (error) layer.error = error;
      out.push(layer);
    }
    const value = getAt(this.base.doc(), path);
    out.push(value === undefined ? { from: "base" } : { from: "base", value });
    return out;
  }

  /** What patches decide in the string at `path`, as shown. */
  highlights(path: readonly A.Prop[]): PatchHighlight[] {
    const shown = getAt(this.handle.doc(), path);
    if (typeof shown !== "string") return [];
    const cover = this.#coverOf(path);
    if (cover) {
      return [{ start: 0, end: shown.length, patch: cover.layer.url, whole: true }];
    }
    const rendered = this.#rendered.get(keyOf(path));
    if (!rendered) return [];
    const base = getAt(this.base.doc(), path);
    return rendered.spans.map((s) => ({
      start: s.os,
      end: s.oe,
      patch: s.cover.layer.url,
      index: s.cover.index,
      ...(s.cover.id ? { id: s.cover.id } : {}),
      base: { start: s.bs, end: s.be },
      ...(typeof base === "string" && s.be > s.bs
        ? { replaced: base.slice(s.bs, s.be) }
        : {}),
    }));
  }

  /** The patch docs this lays itself, front first. */
  laid(): AutomergeUrl[] {
    return this.#laid.map((layer) => layer.url);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    layeredDocs.delete(this.handle.documentId);
    for (const off of this.#offs) off();
    this.#offs.length = 0;
  }

  #listen<D>(
    handle: DocHandle<D>,
    fn: (payload: DocHandleChangePayload<D>) => void
  ): void {
    handle.on("change", fn);
    this.#offs.push(() => handle.off("change", fn));
  }

  #apply(fn: () => void): void {
    const was = this.#applying;
    this.#applying = true;
    try {
      fn();
    } finally {
      this.#applying = was;
    }
  }

  #route(fn: () => void): void {
    const was = this.#routing;
    this.#routing = true;
    try {
      fn();
    } finally {
      this.#routing = was;
    }
  }

  // While a patch this lays is landing, the target changes only where the
  // patch decides, so there's nothing to replay: wait, then lay once.
  #waitForLanding(): boolean {
    if (!this.#laid.some((layer) => landing.has(layer.url))) return false;
    waiting.set(this, () => this.#onLayer());
    return true;
  }

  #hold(fn: () => void): void {
    this.#holding++;
    try {
      fn();
    } finally {
      this.#holding--;
      if (this.#holding === 0 && this.#layerPending) {
        this.#layerPending = false;
        this.#onLayer();
      }
    }
  }

  #collect(): void {
    const covers: Cover[] = [];
    const groups = new Map<string, TextGroup>();
    const groupFor = (path: readonly A.Prop[]) => {
      const key = keyOf(path);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { path, texts: [], marks: [] }));
      return group;
    };
    const below = layersShownBy(this.base);
    this.#laid = this.layers.filter((layer) => !below.has(layer.url));
    let order = 0;
    for (let l = this.#laid.length - 1; l >= 0; l--) {
      const layer = this.#laid[l];
      const patches = layer.doc()?.patches ?? [];
      patches.forEach((entry, index) => {
        if (isTextPatch(entry)) {
          groupFor([...entry.path]).texts.push({
            layer,
            index,
            order: order++,
            from: entry.text.from,
            ...(entry.text.to ? { to: entry.text.to } : {}),
            ...(entry.text.around ? { around: entry.text.around } : {}),
            ...(entry.text.id ? { id: entry.text.id } : {}),
            ...(entry.text.over?.length ? { over: [...entry.text.over] } : {}),
            insert: String(entry.text.insert ?? ""),
          });
        } else if (isMarkPatch(entry)) {
          groupFor([...entry.path]).marks.push({
            layer,
            index,
            order: order++,
            ...entry.mark,
          });
        } else {
          covers.push({
            layer,
            index,
            path: [...entry.path],
            removes: !("value" in entry),
            value: entry.value,
          });
        }
      });
    }
    // A value patch on or above a string decides it whole: text entries on it
    // are set aside.
    for (const [key, group] of groups) {
      if (covers.some((c) => isPrefix(c.path, group.path))) groups.delete(key);
    }
    this.#covers = covers;
    this.#groups = groups;
    const base = this.base.doc();
    this.#lists = new Map();
    for (const c of covers) {
      const parent = c.path.slice(0, -1);
      if (typeof c.path[c.path.length - 1] !== "number") continue;
      if (!Array.isArray(getAt(base, parent))) continue;
      // A value patch on the list (or above it) decides it whole: its index
      // patches lay in order with it, like any other path.
      if (covers.some((o) => isPrefix(o.path, parent))) continue;
      this.#lists.set(keyOf(parent), [...parent]);
    }
  }

  // Where each position the overlay shows in a patched list came from: a
  // target item (its index) or a patch's put (`cover`). Patches apply in
  // order, so a put lands where the list stood when it was applied.
  #origins(parent: readonly A.Prop[]): { base?: number; cover?: Cover }[] {
    const base = getAt(this.base.doc(), parent);
    if (!Array.isArray(base)) return [];
    const origins: { base?: number; cover?: Cover }[] = base.map((_, i) => ({ base: i }));
    for (const cover of this.#covers) {
      if (!this.#inList(cover, parent)) continue;
      const i = cover.path[cover.path.length - 1] as number;
      if (cover.removes) {
        if (i < origins.length) origins.splice(i, 1);
      } else if (i <= origins.length) {
        origins[i] = { cover };
      }
    }
    return origins;
  }

  // A write into a patched list, by where it was made: into the put that
  // shows there (and where), or onto the target item that does (its index
  // translated back, since hidden items shift the overlay's). An insert past
  // what the target has goes on its end.
  #listWrite(
    patch: A.Patch
  ): { cover?: Cover; shownPath: readonly A.Prop[]; patch: A.Patch } | undefined {
    const path = patch.path as A.Prop[];
    for (const parent of this.#lists.values()) {
      if (path.length <= parent.length || !isPrefix(parent, path)) continue;
      const k = path[parent.length];
      if (typeof k !== "number") return undefined;
      const shownPath = path.slice(0, parent.length + 1);
      const origins = this.#origins(parent);
      // Changing an item in place (not inserting or deleting one).
      const inPlace =
        path.length > parent.length + 1 ||
        (patch.action !== "insert" && patch.action !== "del");
      const origin = origins[k];
      if (inPlace && origin?.cover) return { cover: origin.cover, shownPath, patch };
      const base = getAt(this.base.doc(), parent) as unknown[];
      let at = origin?.base;
      for (let j = k; at === undefined && j < origins.length; j++) at = origins[j].base;
      if (at === undefined) at = base.length;
      const moved = [...path];
      moved[parent.length] = at;
      return { shownPath, patch: { ...patch, path: moved } as A.Patch };
    }
    return undefined;
  }

  // Whether a cover sits on an index of the list at `parent`.
  #inList(cover: Cover, parent: readonly A.Prop[]): boolean {
    return cover.path.length === parent.length + 1 && isPrefix(parent, cover.path);
  }

  #listOf(cover: Cover): A.Prop[] | undefined {
    return this.#lists.get(keyOf(cover.path.slice(0, -1)));
  }

  // The front cover a write at `path` lands in: the last one applied at or
  // above it, since that's the one whose value shows there.
  #coverOf(path: readonly A.Prop[]): Cover | undefined {
    for (let i = this.#covers.length - 1; i >= 0; i--) {
      if (isPrefix(this.#covers[i].path, path)) return this.#covers[i];
    }
    return undefined;
  }

  // The patched string a write at `path` is in: the string itself, or one of
  // its characters.
  #groupOf(path: readonly A.Prop[]): TextGroup | undefined {
    for (const group of this.#groups.values()) {
      if (
        isPrefix(group.path, path) &&
        path.length <= group.path.length + 1
      ) {
        return group;
      }
    }
    return undefined;
  }

  // The laid patch that's recording, front first.
  #recorder(): DocHandle<PatchDoc> | undefined {
    return this.#laid.find((layer) => layer.doc()?.record);
  }

  // Whether `front` is laid in front of `layer`.
  #inFront(front: DocHandle<PatchDoc>, layer: DocHandle<PatchDoc>): boolean {
    const f = this.#laid.indexOf(front);
    const l = this.#laid.indexOf(layer);
    return f >= 0 && l >= 0 && f < l;
  }

  // Put every patch onto the overlay doc wherever it doesn't already show. A
  // no-op change makes no Automerge change, so nothing fires.
  #assert(): void {
    this.#errors.clear();
    const base = this.base.doc();
    const shown = new Map<string, { path: readonly A.Prop[]; r: Rendered; marks: ShownMark[] }>();
    for (const [key, group] of this.#groups) {
      const r = renderText(base, group);
      if (r) shown.set(key, { path: group.path, ...r });
    }
    // Strings no longer patched go back to what the target has, unless a
    // value patch decides them now.
    for (const key of this.#rendered.keys()) {
      if (shown.has(key)) continue;
      this.#rendered.delete(key);
      const path = JSON.parse(key) as A.Prop[];
      if (this.#coverOf(path)) continue;
      const r = renderText(base, { path, texts: [], marks: [] });
      if (r) shown.set(key, { path, ...r });
    }

    this.#apply(() =>
      this.handle.change((doc: A.Doc<T>) => {
        for (const parent of this.#lists.values()) {
          const want = getAt(base, parent);
          if (!Array.isArray(want)) continue;
          const list = want.map(plain);
          for (const cover of this.#covers) {
            if (!this.#inList(cover, parent)) continue;
            const i = cover.path[cover.path.length - 1] as number;
            if (cover.removes) {
              if (i < list.length) list.splice(i, 1);
            } else if (i <= list.length) {
              list[i] = plain(cover.value);
            } else {
              this.#errors.set(cover, "past-end");
            }
          }
          syncList(doc, parent, list);
        }
        for (const cover of this.#covers) {
          if (this.#listOf(cover)) continue;
          const error = putAt(doc, cover.path, cover.removes, cover.value);
          if (error) this.#errors.set(cover, error);
        }
        for (const [key, { path, r, marks }] of shown) {
          if (typeof getAt(doc, path) !== "string") continue;
          if (getAt(doc, path) !== r.text) {
            A.updateText(doc as A.Doc<unknown>, [...path], r.text);
          }
          syncMarks(doc as A.Doc<unknown>, path, marks);
          if (this.#groups.has(key)) this.#rendered.set(key, r);
        }
      })
    );
  }

  // The target changed (anyone but us): replay it, except where a patch
  // covers, then put back any patch whose path a change above it replaced.
  #onBase(payload: DocHandleChangePayload<T>): void {
    if (this.#routing || this.#disposed) return;
    if (this.#waitForLanding()) return;
    // The base was re-pointed (a parent overlay laid different patches): what
    // it shows underneath may have changed, so start over from it.
    if ((payload as { scopeReplaced?: boolean }).scopeReplaced) {
      this.#rebuild();
      return;
    }
    const lists = [...this.#lists.values()];
    const patches = payload.patches.filter(
      (p) =>
        !this.#coverOf(p.path) &&
        !this.#groupOf(p.path) &&
        !lists.some((list) => isPrefix(list, p.path))
    );
    if (patches.length > 0) {
      try {
        this.#apply(() =>
          this.handle.change((doc: A.Doc<T>) => applyAll(doc, patches))
        );
      } catch (err) {
        console.warn("[patch-layers] replay failed, rebuilding:", err);
        this.#rebuild();
        return;
      }
    }
    this.#assert();
  }

  // A patch doc changed: put the target's value back wherever a patch went
  // away, then lay the patches again.
  #onLayer(): void {
    if (this.#disposed) return;
    if (this.#waitForLanding()) return;
    if (this.#holding) {
      this.#layerPending = true;
      return;
    }
    const before = this.#covers;
    const lists = this.#lists;
    this.#collect();
    const gone = before.filter(
      (old) =>
        !lists.has(keyOf(old.path.slice(0, -1))) &&
        !this.#covers.some((c) => samePath(c.path, old.path))
    );
    const unlisted = [...lists].filter(([key]) => !this.#lists.has(key));
    if (gone.length > 0 || unlisted.length > 0) {
      this.#apply(() =>
        this.handle.change((doc: A.Doc<T>) => {
          for (const old of gone) {
            const value = getAt(this.base.doc(), old.path);
            putAt(doc, old.path, value === undefined, value);
          }
          for (const [, parent] of unlisted) {
            const want = getAt(this.base.doc(), parent);
            if (Array.isArray(want)) syncList(doc, parent, want.map(plain));
          }
        })
      );
    }
    this.#assert();
  }

  // A tool wrote to the overlay doc. Each patch it made lands in the patch
  // that shows there, in the recording patch, or on the target. A write above
  // a cover (replacing the object a patch sits in) goes to the target, and the
  // cover takes what the overlay now shows at its path, so the write isn't
  // undone by the patch. Edits to patched strings are routed one at a time, in
  // order, each against what the string showed after the last.
  #onWrite(payload: DocHandleChangePayload<T>): void {
    if (this.#applying || this.#disposed) return;
    const recorder = this.#recorder();
    const toBase: A.Patch[] = [];
    // Each cover a write lands in, and where the overlay shows it.
    const dirty = new Map<Cover, readonly A.Prop[]>();
    const texts: { path: readonly A.Prop[]; patch: A.Patch }[] = [];
    const recorded: A.Prop[][] = [];
    const shown = this.handle.doc();

    for (const patch of payload.patches) {
      const listed = this.#listWrite(patch);
      // Recording over a patch behind the recording one: the write goes into
      // the recording patch, which shows in front of it. (Strings there are
      // recorded whole.)
      const record = () => {
        const at = textPathOf(patch, shown, shown) ?? recordPathOf(patch, shown);
        if (at) recorded.push(at);
        return at !== undefined;
      };
      const over = (layer: DocHandle<PatchDoc>) =>
        !!recorder && this.#inFront(recorder, layer) && record();
      if (listed?.cover) {
        if (over(listed.cover.layer)) continue;
        dirty.set(listed.cover, listed.shownPath);
        continue;
      }
      const cover = listed ? undefined : this.#coverOf(patch.path);
      if (cover) {
        if (over(cover.layer)) continue;
        dirty.set(cover, cover.path);
        continue;
      }
      if (listed) {
        if (!recorder || !record()) toBase.push(listed.patch);
        continue;
      }
      const group = this.#groupOf(patch.path);
      if (group) {
        // Deleting the string, or putting something else there, is a write
        // over it, not into it: the target's.
        if (isTextWrite(patch, group.path)) texts.push({ path: group.path, patch });
        else toBase.push(patch);
        continue;
      }
      const text = recorder && textPathOf(patch, shown, this.base.doc());
      if (text) {
        texts.push({ path: text, patch });
        continue;
      }
      const under = recorder && recordPathOf(patch, shown);
      if (under) {
        recorded.push(under);
      } else {
        toBase.push(patch);
      }
      for (const c of this.#covers) {
        // A cover behind the recording patch is hidden by what it records.
        if (recorder && under && this.#inFront(recorder, c.layer)) continue;
        if (isPrefix(under || patch.path, c.path)) dirty.set(c, c.path);
      }
    }

    this.#hold(() => {
      // Lay again once it's all routed, whatever it touched.
      this.#layerPending = true;
      if (toBase.length > 0) {
        try {
          this.#route(() =>
            this.base.change((doc: A.Doc<T>) => applyAll(doc, toBase))
          );
        } catch (err) {
          console.warn("[patch-layers] write didn't apply to target:", err);
          this.#rebuild();
          return;
        }
      }

      for (const [cover, at] of dirty) {
        const value = getAt(shown, at);
        cover.layer.change((doc) => {
          const entry = doc.patches[cover.index];
          if (!entry || !isPathPatch(entry)) return;
          if (value === undefined) {
            delete entry.value;
          } else if (
            typeof value === "string" &&
            typeof entry.value === "string"
          ) {
            A.updateText(doc, ["patches", cover.index, "value"], value);
          } else {
            entry.value = plain(value);
          }
        });
      }

      for (const { path, patch } of texts) {
        if (patch.action === "mark" || patch.action === "unmark") {
          this.#writeMark(patch, recorder);
        } else {
          this.#writeText(path, patch, recorder);
        }
        // What the next edit is measured against: entries may have moved,
        // merged or appeared.
        this.#refresh();
      }
      if (recorder) this.#record(recorder, recorded, shown);
    });
  }

  // Re-read the patches and what each patched string shows, without
  // touching the overlay (which already shows the write being routed).
  #refresh(): void {
    this.#collect();
    const base = this.base.doc();
    for (const [key, group] of this.#groups) {
      const r = renderText(base, group);
      if (r) this.#rendered.set(key, r.r);
    }
  }

  // One edit to a patched string (or, recording, any string): `a`..`b` of
  // what it showed became `x`. It goes where it's seen: into the text entry
  // it's in or touches, else to the target (or, recording, into a new entry).
  #writeText(
    path: readonly A.Prop[],
    patch: A.Patch,
    recorder: DocHandle<PatchDoc> | undefined
  ): void {
    const key = keyOf(path);
    const rendered = this.#rendered.get(key);
    const before = rendered?.text ?? getAt(this.base.doc(), path);
    if (typeof before !== "string") return;
    const edit = textEditOf(patch, path, before);
    if (!edit) return;
    const { start: a, end: b, insert: x } = edit;
    const after = before.slice(0, a) + x + before.slice(b);
    const spans = rendered?.spans ?? [];
    const touched = spans.filter((s) => s.os <= b && a <= s.oe);

    if (touched.length === 0) {
      const bs = outToBase(spans, a);
      const be = outToBase(spans, b);
      if (recorder) {
        const base = this.base.doc();
        const heads = this.base.heads();
        recorder.change((doc) => {
          doc.patches.push(textEntry(base, path, bs, be, x, heads));
        });
        return;
      }
      this.#route(() =>
        this.base.change((doc: A.Doc<T>) =>
          A.splice(doc as A.Doc<unknown>, [...path], bs, be - bs, x)
        )
      );
      return;
    }

    if (
      recorder &&
      touched.some((s) => s.cover.layer !== recorder) &&
      touched.every(
        (s) => s.cover.layer === recorder || this.#inFront(recorder, s.cover.layer)
      )
    ) {
      this.#recordOver(path, recorder, spans, touched, a, b, x, before, after);
      return;
    }

    const only = touched.length === 1 ? touched[0] : undefined;
    if (only && a >= only.os && b <= only.oe) {
      const was = only.cover.insert;
      const insert = was.slice(0, a - only.os) + x + was.slice(b - only.os);
      only.cover.layer.change((doc) => {
        const entry = doc.patches[only.cover.index];
        if (!entry || !isTextPatch(entry)) return;
        A.updateText(doc, ["patches", only.cover.index, "text", "insert"], insert);
      });
      if (only.cover.id) {
        this.#moveMarks([only], a, b, x.length, only.cover.id, only.os);
      }
      return;
    }

    // The edit spans more than one entry, or an entry and the text beside
    // it: the run becomes one entry, in the recording patch if it's one of
    // them, else the frontmost.
    const owner =
      touched.find((s) => s.cover.layer === recorder) ??
      touched.reduce((m, s) => (s.cover.order > m.cover.order ? s : m));
    const os = Math.min(a, ...touched.map((s) => s.os));
    const oe = Math.max(b, ...touched.map((s) => s.oe));
    const { bs, be } = mergedRun(spans, touched, os, oe);
    const insert = after.slice(os, oe + after.length - before.length);
    const base = this.base.doc();
    const heads = this.base.heads();
    const id = owner.cover.id ?? newId();
    const entry = textEntry(base, path, bs, be, insert, heads, id);
    const over = [...new Set(touched.flatMap((s) => s.cover.over ?? []))];
    if (over.length > 0) entry.text.over = over;
    owner.cover.layer.change((doc) => {
      doc.patches[owner.cover.index] = entry;
    });
    this.#moveMarks(touched, a, b, x.length, id, os);
    const drop = touched
      .filter((s) => s !== owner)
      .sort((p, q) => q.cover.index - p.cover.index);
    for (const s of drop) {
      s.cover.layer.change((doc) => {
        doc.patches.splice(s.cover.index, 1);
      });
    }
  }

  // Recording an edit to text that patches behind the recording one add: the
  // run (with whatever of the recording patch's own it touched) becomes one
  // entry in the recording patch, made over theirs, which stay as they are.
  #recordOver(
    path: readonly A.Prop[],
    recorder: DocHandle<PatchDoc>,
    spans: Span[],
    touchedHere: Span[],
    a: number,
    b: number,
    x: string,
    before: string,
    after: string
  ): void {
    const touched = [...touchedHere];
    const os = Math.min(a, ...touched.map((s) => s.os));
    let oe = Math.max(b, ...touched.map((s) => s.oe));
    let { bs, be } = mergedRun(spans, touched, os, oe);
    // Text another patch inserts at the same place, shown right after, would
    // show before the recording patch's (it's further back): take it too.
    for (let next; bs === be; ) {
      next = spans.find(
        (s) => !touched.includes(s) && s.os === oe && s.bs === bs && s.be === be
      );
      if (!next || next.cover.layer === recorder) break;
      touched.push(next);
      oe = next.oe;
    }
    ({ bs, be } = mergedRun(spans, touched, os, oe));
    const own = touched.filter((s) => s.cover.layer === recorder);
    const others = touched.filter((s) => s.cover.layer !== recorder);
    const insert = after.slice(os, oe + after.length - before.length);
    const over = new Set<string>();
    for (const s of others) over.add(this.#idOf(s.cover));
    for (const s of touched) for (const id of s.cover.over ?? []) over.add(id);
    const keep = own[0];
    const id = keep?.cover.id ?? newId();
    const entry = textEntry(this.base.doc(), path, bs, be, insert, this.base.heads(), id);
    entry.text.over = [...over];
    // Entries at one place show in list order: it goes before the recording
    // patch's own that show after it there.
    const later = spans
      .filter(
        (s) =>
          s.cover.layer === recorder &&
          !touched.includes(s) &&
          s.bs === bs &&
          s.be === be &&
          s.os >= oe
      )
      .map((s) => s.cover.index);
    recorder.change((doc) => {
      let at = later.length > 0 ? Math.min(...later) : doc.patches.length;
      const drop = own.map((s) => s.cover.index).sort((p, q) => q - p);
      for (const i of drop) {
        doc.patches.splice(i, 1);
        if (i < at) at--;
      }
      doc.patches.splice(at, 0, entry);
    });
    this.#moveMarks(touched, a, b, x.length, id, os, recorder);
  }

  // Marks on text an entry adds hold offsets into it. After an edit (`a`..`b`
  // of the old shown text became `length` characters), move those marks with
  // the text, onto the entry `id` that now holds it, whose text starts at
  // `os`. Given `into`, marks in other patches stay, and copies go into it.
  #moveMarks(
    touched: Span[],
    a: number,
    b: number,
    length: number,
    id: string,
    os: number,
    into?: DocHandle<PatchDoc>
  ): void {
    const spans = new Map<string, Span>();
    for (const s of touched) if (s.cover.id) spans.set(s.cover.id, s);
    if (spans.size === 0) return;
    const move = moveThrough(a, b, length);
    for (const layer of this.#laid) {
      const hits: [number, Span][] = [];
      (layer.doc()?.patches ?? []).forEach((e, i) => {
        const span = isMarkPatch(e) && e.mark.within ? spans.get(e.mark.within) : undefined;
        if (span) hits.push([i, span]);
      });
      if (hits.length === 0) continue;
      if (into && layer !== into) {
        const copies = hits.map(([i, span]) => {
          const e = layer.doc()!.patches[i] as MarkPatch;
          const { from: _from, to: _to, ...mark } = e.mark;
          const copy: MarkPatch = {
            path: [...e.path],
            mark: {
              ...mark,
              start: move(span.os + (mark.start ?? 0), "start") - os,
              end: move(span.os + (mark.end ?? 0), "end") - os,
              within: id,
            },
          };
          if (e.at) copy.at = [...e.at] as UrlHeads;
          return copy;
        });
        into.change((doc) => void doc.patches.push(...copies));
        continue;
      }
      layer.change((doc) => {
        for (const [i, span] of hits) {
          const m = (doc.patches[i] as MarkPatch).mark;
          m.start = move(span.os + (m.start ?? 0), "start") - os;
          m.end = move(span.os + (m.end ?? 0), "end") - os;
          m.within = id;
        }
      });
    }
  }

  // A tool marked a patched string. The part over the target's own text goes
  // on the target (or, recording, into the recording patch); the part over
  // text an entry adds goes into a mark on that text, in that entry's patch
  // (or the recording one).
  #writeMark(patch: A.Patch, recorder: DocHandle<PatchDoc> | undefined): void {
    const group = this.#groupOf(patch.path);
    if (!group) return;
    const spans = this.#rendered.get(keyOf(group.path))?.spans ?? [];
    const path = [...group.path];
    const runs =
      patch.action === "mark"
        ? patch.marks.map((m) => ({ ...m, value: m.value as A.MarkValue | null }))
        : patch.action === "unmark"
          ? [{ name: patch.name, value: null, start: patch.start, end: patch.end }]
          : [];
    const heads = this.base.heads();
    for (const m of runs) {
      const { own, added } = splitRun(spans, m.start, m.end);
      for (const [s, e] of own) {
        const bs = outToBase(spans, s);
        const be = outToBase(spans, e);
        if (be <= bs) continue;
        if (recorder) {
          const entry = markEntry(this.base.doc(), path, bs, be, m.name, m.value, heads);
          recorder.change((doc) => void doc.patches.push(entry));
          continue;
        }
        this.#route(() =>
          this.base.change((doc: A.Doc<T>) => {
            const range = { start: bs, end: be, expand: "none" as const };
            if (m.value === null) A.unmark(doc as A.Doc<unknown>, path, range, m.name);
            else A.mark(doc as A.Doc<unknown>, path, range, m.name, m.value);
          })
        );
      }
      for (const { span, start, end } of added) {
        const id = this.#idOf(span.cover);
        const entry: MarkPatch = {
          path,
          at: heads,
          mark: { name: m.name, value: m.value, within: id, start, end },
        };
        (recorder ?? span.cover.layer).change((doc) => void doc.patches.push(entry));
      }
    }
  }

  // A text entry's id, giving it one if it has none yet.
  #idOf(cover: TextCover): string {
    if (cover.id) return cover.id;
    const id = newId();
    cover.layer.change((doc) => {
      const entry = doc.patches[cover.index];
      if (entry && isTextPatch(entry)) entry.text.id = id;
    });
    cover.id = id;
    return id;
  }

  // Recording: each path a write touched goes into the recording patch with
  // what the overlay now shows there.
  #record(
    recorder: DocHandle<PatchDoc>,
    paths: A.Prop[][],
    shown: unknown
  ): void {
    if (paths.length === 0) return;
    const sorted = [...paths].sort((p, q) => p.length - q.length);
    const keep: A.Prop[][] = [];
    for (const path of sorted) {
      if (!keep.some((k) => isPrefix(k, path))) keep.push(path);
    }
    const heads = this.base.heads();
    recorder.change((doc) => {
      for (const path of keep) {
        const value = getAt(shown, path);
        const entry: PathPatch =
          value === undefined
            ? { path: [...path], at: heads }
            : { path: [...path], value: plain(value), at: heads };
        const i = doc.patches.findIndex(
          (e) => isPathPatch(e) && samePath(e.path, path)
        );
        if (i >= 0) doc.patches[i] = entry;
        else doc.patches.push(entry);
      }
    });
  }

  // Start over from the target: a fresh copy with the patches laid on it.
  // Tools see a whole-document change.
  #rebuild(): void {
    this.#apply(() => this.handle.update(() => A.clone(this.base.fullDoc())));
    this.#rendered.clear();
    this.#collect();
    this.#assert();
  }
}

/**
 * Make a patch doc over `target`, against its current heads. The patch doc is
 * an ordinary document in `repo`: put it in a folder a patch provider reads.
 */
export function createPatch<T>(
  repo: Pick<Repo, "create">,
  target: DocHandle<T>,
  patches: PatchEntry[] = []
): DocHandle<PatchDoc> {
  return repo.create<PatchDoc>({
    "@patchwork": { type: "patch" },
    on: target.url,
    at: target.heads(),
    patches: patches.map((p) => plain(p) as PatchEntry),
  });
}

/**
 * A text entry replacing `start`..`end` of the string at `path` in `target`
 * (as of `heads`, or now) with `insert`. `start === end` inserts.
 */
export function textPatch<T>(
  target: DocHandle<T>,
  path: A.Prop[],
  start: number,
  end: number,
  insert: string,
  heads?: UrlHeads
): TextPatch {
  const at = heads ?? target.heads();
  return textEntry(target.view(at).doc(), path, start, end, insert, at);
}

/** A mark entry over `start`..`end` of the string at `path` in `target`. */
export function markPatch<T>(
  target: DocHandle<T>,
  path: A.Prop[],
  start: number,
  end: number,
  name: string,
  value: A.MarkValue | null,
  heads?: UrlHeads
): MarkPatch {
  const at = heads ?? target.heads();
  return markEntry(target.view(at).doc(), path, start, end, name, value, at);
}

export type OpsError = { index: number; code: string; message: string };

/**
 * Turn Automerge patches (the kind `A.applyPatches` takes, applied one after
 * another) into patch entries against `target` as of `heads` (or now). Text
 * indexes become cursors, so the entries go on holding the same characters as
 * the target changes; the other ops become value entries at the paths they
 * touch. Ops that can't be read are reported, not kept.
 */
export function fromAutomergePatches<T>(
  target: DocHandle<T>,
  ops: readonly A.Patch[],
  heads?: UrlHeads
): { entries: PatchEntry[]; errors: OpsError[] } {
  const at = heads ?? target.heads();
  const doc = target.view(at).doc() as A.Doc<unknown>;
  let sim = A.clone(doc);
  const errors: OpsError[] = [];
  const valuePaths: A.Prop[][] = [];
  // Per string: its runs, in the target's positions, kept non-overlapping.
  const runs = new Map<string, { path: A.Prop[]; hunks: Hunk[] }>();
  const markEntries: MarkPatch[] = [];
  // Marks on added text, kept by hunk so later edits can move them.
  const within: { path: A.Prop[]; hunk: string; start: number; end: number; name: string; value: A.MarkValue | null }[] = [];
  // A path some op has put (or otherwise changed as a value): later ops under
  // it change that value, not the target's text.
  const valued = (path: A.Prop[]) => valuePaths.some((v) => isPrefix(v, path));

  const runsOf = (path: A.Prop[]) => {
    const key = keyOf(path);
    let r = runs.get(key);
    if (!r) runs.set(key, (r = { path, hunks: [] }));
    return r;
  };
  const fail = (index: number, code: string, message: string) =>
    errors.push({ index, code, message });

  ops.forEach((op, index) => {
    if (!op || !Array.isArray(op.path)) {
      return fail(index, "bad-op", "every op needs an action and a path");
    }
    const path = op.path as A.Prop[];
    const parent = path.slice(0, -1);
    const last = path[path.length - 1];
    const parentText = getAt(doc, parent);

    if (
      (op.action === "splice" || op.action === "del") &&
      typeof last === "number" &&
      typeof parentText === "string" &&
      !valued(parent)
    ) {
      const r = runsOf(parent);
      const shown = applyHunks(parentText, r.hunks);
      const length = op.action === "del" ? (op.length ?? 1) : 0;
      if (last < 0 || last + length > shown.length) {
        return fail(
          index,
          "past-end",
          `${formatPath(parent)} is ${shown.length} characters, so there's no index ${last + length}.`
        );
      }
      const insert = op.action === "splice" ? String(op.value) : "";
      const edit = editHunks(parentText, r.hunks, last, last + length, insert);
      r.hunks = edit.hunks;
      const move = moveThrough(last, last + length, insert.length);
      for (const m of within) {
        const at = edit.was.get(m.hunk);
        if (at === undefined || !samePath(m.path, parent)) continue;
        m.start = move(at + m.start, "start") - edit.os;
        m.end = move(at + m.end, "end") - edit.os;
        m.hunk = edit.merged.id;
      }
      return;
    }

    if ((op.action === "mark" || op.action === "unmark") && !valued(path)) {
      const text = getAt(doc, path);
      if (typeof text !== "string") {
        return fail(index, "not-text", `${formatPath(path)} isn't a string.`);
      }
      const hunks = runs.get(keyOf(path))?.hunks ?? [];
      const shownLength = applyHunks(text, hunks).length;
      const list =
        op.action === "mark"
          ? op.marks
          : [{ name: op.name, value: null, start: op.start, end: op.end }];
      for (const m of list) {
        if (m.start < 0 || m.end > shownLength || m.end <= m.start) {
          fail(index, "bad-range", `${m.start}..${m.end} isn't a run of ${formatPath(path)}.`);
          continue;
        }
        const value = m.value as A.MarkValue | null;
        const spans = hunkSpans(text, hunks);
        const { own, added } = splitRun(spans, m.start, m.end);
        for (const [s, e] of own) {
          const bs = outToBase(spans, s);
          const be = outToBase(spans, e);
          if (be > bs) markEntries.push(markEntry(doc, path, bs, be, m.name, value, at));
        }
        for (const piece of added) {
          const hunk = hunks[spans.indexOf(piece.span)];
          within.push({ path: [...path], hunk: hunk.id, start: piece.start, end: piece.end, name: m.name, value });
        }
      }
      return;
    }

    if (op.action === "conflict") return;
    try {
      sim = A.change(sim, (d) => A.applyPatches(d, [op]));
    } catch (err) {
      return fail(index, "bad-op", err instanceof Error ? err.message : String(err));
    }
    valuePaths.push(recordPathOf(op, sim) || path);
  });

  const entries: PatchEntry[] = [];
  const sorted = valuePaths.sort((p, q) => p.length - q.length);
  const kept: A.Prop[][] = [];
  for (const path of sorted) {
    if (kept.some((k) => isPrefix(k, path))) continue;
    kept.push(path);
    const value = getAt(sim, path);
    entries.push(
      value === undefined
        ? { path: [...path], at }
        : { path: [...path], value: plain(value), at }
    );
  }
  for (const { path, hunks } of runs.values()) {
    for (const h of hunks) {
      entries.push(textEntry(doc, path, h.bs, h.be, h.insert, at, h.id));
    }
  }
  entries.push(...markEntries);
  for (const m of within) {
    entries.push({
      path: m.path,
      at,
      mark: { name: m.name, value: m.value, within: m.hunk, start: m.start, end: m.end },
    });
  }
  return { entries, errors };
}

/**
 * Whether the target has changed, since the entry was made, what the entry
 * changes: the value at its path, or the run of text it replaces or marks. An
 * entry made against heads the target doesn't have yet counts as stale:
 * nothing can be said about it until they arrive.
 */
export function isEntryStale<T>(
  target: DocHandle<T>,
  patch: Pick<PatchDoc, "at">,
  entry: PatchEntry
): boolean {
  const reading = readEntry(target, patch, entry);
  return reading.stale;
}

/** Whether any of the patch's entries is stale. */
export function isPatchStale<T>(
  target: DocHandle<T>,
  patch: PatchDoc
): boolean {
  return patch.patches.some((e) => isEntryStale(target, patch, e));
}

export type EntryReading = {
  kind: "put" | "remove" | "text" | "mark";
  path: A.Prop[];
  stale: boolean;
  /** What the target had there when the entry was made. */
  then?: unknown;
  /** What the target has there now. */
  now?: unknown;
  /** Text and marks: the run in the target now, and the text either side. */
  range?: { start: number; end: number };
  before?: string;
  after?: string;
};

/** What an entry changes, then and now, for showing it. */
export function readEntry<T>(
  target: DocHandle<T>,
  patch: Pick<PatchDoc, "at">,
  entry: PatchEntry
): EntryReading {
  const path = [...entry.path];
  const kind = isTextPatch(entry)
    ? "text"
    : isMarkPatch(entry)
      ? "mark"
      : "value" in entry
        ? "put"
        : "remove";
  const at = entry.at ?? patch.at;
  const known = !!at && target.containsHeads(at);
  const nowDoc = target.doc();
  const thenDoc = known ? target.view(at).doc() : undefined;

  if (kind === "put" || kind === "remove") {
    const now = getAt(nowDoc, path);
    const then = thenDoc ? getAt(thenDoc, path) : undefined;
    return {
      kind,
      path,
      stale: !known || !deepEqual(then, now),
      ...(then === undefined ? {} : { then }),
      ...(now === undefined ? {} : { now }),
    };
  }

  if (isMarkPatch(entry) && entry.mark.within !== undefined) {
    const { within, start = 0, end = 0 } = entry.mark;
    const host = (patch as Partial<PatchDoc>).patches?.find(
      (e) => isTextPatch(e) && e.text.id === within
    ) as TextPatch | undefined;
    const added = host ? String(host.text.insert) : undefined;
    return {
      kind,
      path,
      stale: false,
      ...(added === undefined
        ? {}
        : {
            now: added.slice(start, end),
            before: added.slice(Math.max(0, start - 24), start),
            after: added.slice(end, end + 24),
          }),
    };
  }
  const run = isTextPatch(entry)
    ? entry.text
    : { from: (entry as MarkPatch).mark.from!, to: (entry as MarkPatch).mark.to };
  if (!run.from) return { kind, path, stale: true };
  const text = getAt(nowDoc, path);
  const nowRange =
    typeof text === "string" ? resolveRun(nowDoc, path, run.from, run.to, aroundOf(entry)) : undefined;
  const thenText = thenDoc ? getAt(thenDoc, path) : undefined;
  const thenRange =
    thenDoc && typeof thenText === "string"
      ? resolveRun(thenDoc, path, run.from, run.to, aroundOf(entry))
      : undefined;
  const now =
    nowRange && typeof text === "string"
      ? text.slice(nowRange.start, nowRange.end)
      : undefined;
  const then =
    thenRange && typeof thenText === "string"
      ? thenText.slice(thenRange.start, thenRange.end)
      : undefined;
  const reading: EntryReading = {
    kind,
    path,
    // A run that can't be found any more (its string was replaced whole)
    // is stale; an insert replaces nothing, so otherwise it never is.
    stale:
      !known ||
      !nowRange ||
      (run.to !== undefined && (!thenRange || then !== now)),
    ...(then === undefined ? {} : { then }),
    ...(now === undefined ? {} : { now }),
  };
  if (nowRange && typeof text === "string") {
    reading.range = nowRange;
    reading.before = text.slice(Math.max(0, nowRange.start - 24), nowRange.start);
    reading.after = text.slice(nowRange.end, nowRange.end + 24);
  }
  return reading;
}

/**
 * Put a patch's entries on its target for real and empty it. Anything laying
 * it over the target sees no difference: overlays laying it wait until it's
 * landed, then lay once.
 *
 * Returns where each of its text entries' text now starts in the target, by
 * entry id, so marks other patches put on that text can follow it.
 */
export function landPatch<T>(
  target: DocHandle<T>,
  layer: DocHandle<PatchDoc>
): Map<string, number> {
  const patches = layer.doc()?.patches ?? [];
  const values = patches.filter(isPathPatch);
  const marks = patches.filter(isMarkPatch);

  // The patch's text, as an overlay laying it alone would show it.
  const groups = new Map<string, TextGroup>();
  patches.forEach((entry, index) => {
    if (!isTextPatch(entry)) return;
    const key = keyOf(entry.path);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { path: [...entry.path], texts: [], marks: [] }));
    group.texts.push({
      layer,
      index,
      order: index,
      from: entry.text.from,
      ...(entry.text.to ? { to: entry.text.to } : {}),
      ...(entry.text.around ? { around: entry.text.around } : {}),
      ...(entry.text.id ? { id: entry.text.id } : {}),
      insert: String(entry.text.insert ?? ""),
    });
  });

  let landed = new Map<string, number>();
  landing.add(layer.url);
  try {
    target.change((doc: A.Doc<T>) => {
      for (const p of values) putAt(doc, p.path, !("value" in p), p.value);
    });
    // Where each entry's text ends up, for marks on it.
    landed = new Map<string, number>();
    const now = target.doc();
    const runs: { path: A.Prop[]; spans: Span[] }[] = [];
    for (const group of groups.values()) {
      const r = renderText(now, group);
      if (!r) continue;
      runs.push({ path: [...group.path], spans: r.r.spans });
      for (const span of r.r.spans) {
        if (span.cover.id) landed.set(span.cover.id, span.os);
      }
    }
    if (runs.length > 0) {
      target.change((doc: A.Doc<T>) => {
        // Last run first, so the positions before it hold.
        for (const { path, spans } of runs) {
          for (const span of [...spans].reverse()) {
            A.splice(doc as A.Doc<unknown>, path, span.bs, span.be - span.bs, span.cover.insert);
          }
        }
      });
    }
    if (marks.length > 0) {
      const after = target.doc();
      target.change((doc: A.Doc<T>) => {
        for (const m of marks) {
          let r: { start: number; end: number } | undefined;
          if (m.mark.within !== undefined) {
            const at = landed.get(m.mark.within);
            if (at === undefined) continue;
            r = { start: at + (m.mark.start ?? 0), end: at + (m.mark.end ?? 0) };
          } else if (m.mark.from && m.mark.to) {
            r = resolveRun(after, m.path, m.mark.from, m.mark.to);
          }
          if (!r || r.end <= r.start) continue;
          const range = { start: r.start, end: r.end, expand: "none" as const };
          if (m.mark.value === null) {
            A.unmark(doc as A.Doc<unknown>, [...m.path], range, m.mark.name);
          } else {
            A.mark(doc as A.Doc<unknown>, [...m.path], range, m.mark.name, m.mark.value);
          }
        }
      });
    }
    // Marks on another patch's text can't land with this one: they stay.
    const kept = marks.filter(
      (m) => m.mark.within !== undefined && !landed.has(m.mark.within)
    );
    const heads = target.heads();
    layer.change((doc) => {
      doc.patches.splice(0, doc.patches.length, ...(kept.map(plain) as PatchEntry[]));
      doc.landedAt = heads;
    });
  } finally {
    landing.delete(layer.url);
    const settle = [...waiting.values()];
    waiting.clear();
    for (const fn of settle) fn();
  }
  return landed;
}

// --- text ---------------------------------------------------------------

// A run of the target's text (`bs`..`be`) replaced by `insert`.
type Hunk = { bs: number; be: number; insert: string; id: string };

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Split a shown run into the parts over the target's own text and the parts
// over text an entry adds (as offsets into that text).
function splitRun(
  spans: Span[],
  start: number,
  end: number
): { own: [number, number][]; added: { span: Span; start: number; end: number }[] } {
  const own: [number, number][] = [];
  const added: { span: Span; start: number; end: number }[] = [];
  let at = start;
  for (const span of [...spans].sort((p, q) => p.os - q.os)) {
    if (at >= end) break;
    if (span.oe <= at) continue;
    if (span.os > at) own.push([at, Math.min(span.os, end)]);
    const s = Math.max(at, span.os);
    const e = Math.min(end, span.oe);
    if (e > s) added.push({ span, start: s - span.os, end: e - span.os });
    at = Math.max(at, span.oe);
  }
  if (at < end) own.push([at, end]);
  return { own, added };
}

function markEntry(
  doc: unknown,
  path: readonly A.Prop[],
  start: number,
  end: number,
  name: string,
  value: A.MarkValue | null,
  at: UrlHeads
): MarkPatch {
  const d = doc as A.Doc<unknown>;
  const p = [...path];
  return {
    path: p,
    at,
    mark: {
      from: A.getCursor(d, p, start, "after"),
      to: A.getCursor(d, p, Math.max(start, end - 1), "before"),
      name,
      value,
    },
  };
}

function textEntry(
  doc: unknown,
  path: readonly A.Prop[],
  bs: number,
  be: number,
  insert: string,
  at: UrlHeads,
  id: string = newId()
): TextPatch {
  const d = doc as A.Doc<unknown>;
  const p = [...path];
  const length = (getAt(doc, path) as string).length;
  const from =
    be > bs || bs < length
      ? A.getCursor(d, p, bs, "after")
      : A.getCursor(d, p, "end");
  if (be <= bs) return { path: p, at, text: { from, insert, id } };
  const around: [A.Cursor, A.Cursor] = [
    bs > 0 ? A.getCursor(d, p, bs - 1, "before") : A.getCursor(d, p, "start"),
    be < length ? A.getCursor(d, p, be, "after") : A.getCursor(d, p, "end"),
  ];
  return {
    path: p,
    at,
    text: { from, to: A.getCursor(d, p, be - 1, "before"), around, insert, id },
  };
}

// Where a cursor-held run is in `doc` now: from `from`'s character through
// `to`'s, or (no `to`) the point before `from`'s.
function resolveRun(
  doc: unknown,
  path: readonly A.Prop[],
  from: A.Cursor,
  to: A.Cursor | undefined,
  around?: readonly [A.Cursor, A.Cursor]
): { start: number; end: number } | undefined {
  try {
    const d = doc as A.Doc<unknown>;
    const p = [...path];
    let start = A.getCursorPosition(d, p, from);
    if (to === undefined) return { start, end: start };
    let end = A.getCursorPosition(d, p, to) + 1;
    if (around) {
      // A cursor whose character is gone resolves somewhere near it; where
      // the run's own edge was deleted, its neighbour marks the edge.
      if (!holds(d, p, start, from, "after")) {
        start = gapAfter(d, p, around[0]);
      }
      if (!holds(d, p, end - 1, to, "before")) {
        end = A.getCursorPosition(d, p, around[1]);
      }
    }
    return { start, end: Math.max(start, end) };
  } catch {
    return undefined;
  }
}

// The position just after the character `cursor` (a "before" cursor) was
// made on. If that character is gone, a "before" cursor resolves to the one
// before it, which can't be told apart from there being none; the same
// cursor moving "after" resolves to the gap it left, which can. (Automerge
// writes a "before" cursor as the "after" one with a leading "-".)
function gapAfter(doc: A.Doc<unknown>, path: A.Prop[], cursor: A.Cursor): number {
  if (cursor === "s") return 0;
  const at = A.getCursorPosition(doc, path, cursor);
  if (holds(doc, path, at, cursor, "before")) return at + 1;
  if (cursor.startsWith("-")) return A.getCursorPosition(doc, path, cursor.slice(1));
  return at + 1;
}

// Whether the character at `index` is the one `cursor` was made on. (A
// cursor's string carries which way it moves, so compare like with like.)
function holds(
  doc: A.Doc<unknown>,
  path: A.Prop[],
  index: number,
  cursor: A.Cursor,
  move: A.MoveCursor
): boolean {
  const text = getAt(doc, path);
  if (typeof text !== "string" || index < 0 || index >= text.length) {
    return false;
  }
  return A.getCursor(doc, path, index, move) === cursor;
}

function aroundOf(entry: PatchEntry): [A.Cursor, A.Cursor] | undefined {
  return isTextPatch(entry) ? entry.text.around : undefined;
}

// What a patched string shows: the target's text with every text entry laid
// on it (front wins where runs overlap), and the marks it shows.
function renderText(
  base: unknown,
  group: TextGroup
): { r: Rendered; marks: ShownMark[] } | undefined {
  const text = getAt(base, group.path);
  if (typeof text !== "string") return undefined;
  // Runs that replace text first, the front one winning where they overlap;
  // then inserts, which a run replacing the text around them hides. (An
  // insert never hides a run: it changes nothing there to disagree with.)
  const accepted: { cover: TextCover; bs: number; be: number }[] = [];
  const frontFirst = [...group.texts]
    .sort((p, q) => q.order - p.order)
    .map((cover) => ({
      cover,
      run: resolveRun(base, group.path, cover.from, cover.to, cover.around),
    }));
  // Entries a shown entry in front was made over.
  const hidden = new Set<TextCover>();
  for (const { cover, run } of frontFirst) {
    if (!run || !cover.over) continue;
    for (const c of group.texts) {
      if (c.order < cover.order && c.id && cover.over.includes(c.id)) hidden.add(c);
    }
  }
  for (const { cover, run } of frontFirst) {
    if (!run || run.end <= run.start || hidden.has(cover)) continue;
    if (accepted.some((a) => a.bs < run.end && run.start < a.be)) continue;
    accepted.push({ cover, bs: run.start, be: run.end });
  }
  for (const { cover, run } of frontFirst) {
    if (!run || run.end > run.start || hidden.has(cover)) continue;
    if (accepted.some((a) => a.bs < run.start && run.start < a.be)) continue;
    accepted.push({ cover, bs: run.start, be: run.end });
  }
  accepted.sort(
    (p, q) => p.bs - q.bs || p.be - q.be || p.cover.order - q.cover.order
  );
  let out = "";
  let at = 0;
  const spans: Span[] = [];
  for (const a of accepted) {
    out += text.slice(at, a.bs);
    const os = out.length;
    out += a.cover.insert;
    spans.push({ ...a, os, oe: out.length });
    at = a.be;
  }
  out += text.slice(at);

  const marks: ShownMark[] = [];
  const baseMarks = A.marks(base as A.Doc<unknown>, [...group.path]);
  for (const m of baseMarks) {
    const start = baseToOut(spans, m.start, "start");
    const end = baseToOut(spans, m.end, "end");
    if (end > start) marks.push({ name: m.name, value: m.value, start, end });
  }
  const patchMarks = [...group.marks].sort((p, q) => p.order - q.order);
  for (const m of patchMarks) {
    let start: number;
    let end: number;
    if (m.within !== undefined) {
      const span = spans.find((s) => s.cover.id === m.within);
      if (!span) continue;
      const length = span.oe - span.os;
      start = span.os + clamp(m.start ?? 0, 0, length);
      end = span.os + clamp(m.end ?? 0, 0, length);
    } else {
      if (!m.from || !m.to) continue;
      const run = resolveRun(base, group.path, m.from, m.to);
      if (!run || run.end <= run.start) continue;
      start = baseToOut(spans, run.start, "start");
      end = baseToOut(spans, run.end, "end");
    }
    if (end <= start) continue;
    applyShownMark(marks, { name: m.name, value: m.value, start, end });
  }
  return { r: { text: out, spans }, marks };
}

// Lay one mark (or unmark) over a list of shown marks of the same kind.
function applyShownMark(
  marks: ShownMark[],
  m: { name: string; value: A.MarkValue | null; start: number; end: number }
): void {
  for (let i = marks.length - 1; i >= 0; i--) {
    const o = marks[i];
    if (o.name !== m.name || o.end <= m.start || m.end <= o.start) continue;
    marks.splice(i, 1);
    if (o.start < m.start) marks.push({ ...o, end: m.start });
    if (m.end < o.end) marks.push({ ...o, start: m.end });
  }
  if (m.value !== null) marks.push({ ...m, value: m.value });
}

// Make the overlay's marks on a string match `want`, if they don't already.
function syncMarks(
  doc: A.Doc<unknown>,
  path: readonly A.Prop[],
  want: ShownMark[]
): void {
  const p = [...path];
  const have = A.marks(doc, p);
  const norm = (ms: readonly ShownMark[]) =>
    JSON.stringify(
      [...ms]
        .map((m) => [m.name, m.start, m.end, m.value])
        .sort((x, y) => String(x).localeCompare(String(y)))
    );
  if (norm(have as ShownMark[]) === norm(want)) return;
  const length = (getAt(doc, path) as string).length;
  for (const name of new Set([...have, ...want].map((m) => m.name))) {
    A.unmark(doc, p, { start: 0, end: length, expand: "none" }, name);
  }
  for (const m of want) {
    A.mark(doc, p, { start: m.start, end: m.end, expand: "none" }, m.name, m.value);
  }
}

// A target position, as a position in what the overlay shows. Inside a
// replaced run it's the start (or end) of what replaces it.
function baseToOut(spans: Span[], pos: number, side: "start" | "end"): number {
  let delta = 0;
  for (const s of spans) {
    if (pos < s.bs || (pos === s.bs && (side === "start" || s.be > s.bs))) {
      return pos + delta;
    }
    if (pos < s.be) return side === "start" ? s.os : s.oe;
    delta = s.oe - s.be;
  }
  return pos + delta;
}

// An overlay position outside every run's inside, as a target position.
function outToBase(spans: Span[], pos: number): number {
  let delta = 0;
  for (const s of spans) {
    if (pos <= s.os) return pos - delta;
    if (pos < s.oe) return s.bs;
    delta = s.oe - s.be;
  }
  return pos - delta;
}

// The one changed run between two strings: `start`..`end` of `before` became
// `insert`.
function diffRun(
  before: string,
  after: string
): { start: number; end: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    start,
    end: before.length - tail,
    insert: after.slice(start, after.length - tail),
  };
}

function applyHunks(text: string, hunks: Hunk[]): string {
  let out = "";
  let at = 0;
  for (const h of hunks) {
    out += text.slice(at, h.bs) + h.insert;
    at = h.be;
  }
  return out + text.slice(at);
}

function hunkSpans(text: string, hunks: Hunk[]): Span[] {
  let out = 0;
  let at = 0;
  return hunks.map((h) => {
    out += h.bs - at;
    const os = out;
    out += h.insert.length;
    at = h.be;
    return { cover: undefined as unknown as TextCover, bs: h.bs, be: h.be, os, oe: out };
  });
}

// A shown position in `text` with `hunks` laid on it, as a position in
// `text`; inside a hunk, its start (or end).
function shownToBase(
  text: string,
  hunks: Hunk[],
  pos: number,
  side: "start" | "end"
): number {
  const spans = hunkSpans(text, hunks);
  for (const s of spans) {
    if (pos > s.os && pos < s.oe) return side === "start" ? s.bs : s.be;
  }
  return outToBase(spans, pos);
}

// Replace shown `start`..`end` with `insert`, folding every hunk it touches
// into one.
function editHunks(
  text: string,
  hunks: Hunk[],
  start: number,
  end: number,
  insert: string
): { hunks: Hunk[]; merged: Hunk; os: number; was: Map<string, number> } {
  const spans = hunkSpans(text, hunks);
  const shown = applyHunks(text, hunks);
  const touched = spans.filter((s) => s.os <= end && start <= s.oe);
  const os = Math.min(start, ...touched.map((s) => s.os));
  const oe = Math.max(end, ...touched.map((s) => s.oe));
  const { bs, be } = mergedRun(spans, touched, os, oe);
  const after = shown.slice(0, start) + insert + shown.slice(end);
  // Where each touched hunk's text started, for marks on it.
  const was = new Map<string, number>();
  for (const t of touched) was.set(hunks[spans.indexOf(t)].id, t.os);
  const first = touched[0] ? hunks[spans.indexOf(touched[0])] : undefined;
  const merged: Hunk = {
    bs,
    be,
    insert: after.slice(os, oe + after.length - shown.length),
    id: first?.id ?? newId(),
  };
  const rest = hunks.filter((_, i) => !touched.includes(spans[i]));
  return { hunks: [...rest, merged].sort((p, q) => p.bs - q.bs), merged, os, was };
}

// Make the list at `path` hold `want`, changing as little as it can: the
// items both ends agree on stay, so their identity (and anything pointing
// into them) does too.
function syncList(doc: unknown, path: readonly A.Prop[], want: unknown[]): void {
  const list = getAt(doc, path) as unknown[] & {
    insertAt?: (i: number, ...v: unknown[]) => void;
    deleteAt?: (i: number, n?: number) => void;
  };
  if (!Array.isArray(list)) return;
  let head = 0;
  while (head < list.length && head < want.length && deepEqual(list[head], want[head])) head++;
  let tail = 0;
  while (
    tail < list.length - head &&
    tail < want.length - head &&
    deepEqual(list[list.length - 1 - tail], want[want.length - 1 - tail])
  ) {
    tail++;
  }
  const have = list.length - head - tail;
  const put = want.slice(head, want.length - tail);
  const same = Math.min(have, put.length);
  for (let i = 0; i < same; i++) {
    (list as unknown[])[head + i] = plain(put[i]);
  }
  if (have > same) list.deleteAt?.(head + same, have - same);
  if (put.length > same) list.insertAt?.(head + same, ...put.slice(same).map(plain));
}

// `A.applyPatches`, except that it can delete a map's key (it only deletes
// from lists and text).
function applyAll(doc: unknown, patches: readonly A.Patch[]): void {
  for (const patch of patches) {
    const path = patch.path as A.Prop[];
    const key = path[path.length - 1];
    if (patch.action === "del" && typeof key === "string") {
      const parent = getAt(doc, path.slice(0, -1));
      if (parent && typeof parent === "object") {
        delete (parent as Record<string, unknown>)[key];
      }
      continue;
    }
    A.applyPatches(doc as A.Doc<unknown>, [patch]);
  }
}

// Whether a write to a patched string at `path` is an edit to its text (or
// marks), rather than a write over the string itself.
function isTextWrite(patch: A.Patch, path: readonly A.Prop[]): boolean {
  const p = patch.path as A.Prop[];
  if (patch.action === "mark" || patch.action === "unmark") return samePath(p, path);
  if (patch.action === "splice" || patch.action === "del") {
    return p.length === path.length + 1 && isPrefix(path, p) && typeof p[p.length - 1] === "number";
  }
  return patch.action === "put" && samePath(p, path) && typeof patch.value === "string";
}

// What one text write did to the string it's in: `start`..`end` of what it
// showed (`before`) became `insert`.
function textEditOf(
  patch: A.Patch,
  path: readonly A.Prop[],
  before: string
): { start: number; end: number; insert: string } | undefined {
  const p = patch.path as A.Prop[];
  const at = p[path.length];
  if (p.length === path.length + 1 && typeof at === "number") {
    if (patch.action === "splice") return { start: at, end: at, insert: String(patch.value) };
    if (patch.action === "del") return { start: at, end: at + (patch.length ?? 1), insert: "" };
  }
  if (patch.action === "put" && typeof patch.value === "string") {
    return diffRun(before, patch.value);
  }
  return undefined;
}

// Where a position in a string goes when `a`..`b` of it becomes `length`
// characters. A run's start that sat where text was inserted stays before
// it; a run's end there stays after nothing new: inserts at a run's edges
// fall outside it.
function moveThrough(a: number, b: number, length: number) {
  const delta = length - (b - a);
  return (p: number, side: "start" | "end"): number => {
    if (p < a) return p;
    if (p > b) return p + delta;
    if (a === b) return side === "start" ? p + length : p;
    if (p === a) return a;
    if (p === b) return p + delta;
    return side === "start" ? a : a + length;
  };
}

// The run of the target's text that runs `touched` and the shown text
// `os`..`oe` around them cover together. Several runs can meet at one shown
// position (an insert beside a deletion): the widest wins at each edge.
function mergedRun(
  spans: Span[],
  touched: Span[],
  os: number,
  oe: number
): { bs: number; be: number } {
  const starts = touched.filter((s) => s.os === os).map((s) => s.bs);
  const ends = touched.filter((s) => s.oe === oe).map((s) => s.be);
  return {
    bs: starts.length ? Math.min(...starts) : outToBase(spans, os),
    be: ends.length ? Math.max(...ends) : outToBase(spans, oe),
  };
}

// The string a write is editing, when it's a character edit (or a whole new
// string over an old one).
function textPathOf(
  patch: A.Patch,
  shown: unknown,
  base: unknown
): A.Prop[] | undefined {
  const path = patch.path as A.Prop[];
  const last = path[path.length - 1];
  if (
    (patch.action === "splice" || patch.action === "del") &&
    typeof last === "number" &&
    typeof getAt(shown, path.slice(0, -1)) === "string"
  ) {
    return path.slice(0, -1);
  }
  if (
    patch.action === "put" &&
    typeof patch.value === "string" &&
    typeof getAt(base, path) === "string"
  ) {
    return path;
  }
  return undefined;
}

// The smallest path that holds what a write changed: inserting into or
// deleting from a list changes the list.
function recordPathOf(patch: A.Patch, shown: unknown): A.Prop[] | undefined {
  const path = patch.path as A.Prop[];
  if (patch.action === "mark" || patch.action === "unmark") return undefined;
  if (patch.action === "conflict") return undefined;
  const last = path[path.length - 1];
  if (
    (patch.action === "insert" || patch.action === "del") &&
    typeof last === "number" &&
    Array.isArray(getAt(shown, path.slice(0, -1)))
  ) {
    return path.slice(0, -1);
  }
  return path;
}

// --- paths and values ---------------------------------------------------

function keyOf(path: readonly A.Prop[]): string {
  return JSON.stringify(path);
}

function formatPath(path: readonly A.Prop[]): string {
  return path
    .map((k, i) => (typeof k === "number" ? `[${k}]` : i ? `.${k}` : k))
    .join("");
}

function isPrefix(prefix: readonly A.Prop[], path: readonly A.Prop[]): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

function samePath(a: readonly A.Prop[], b: readonly A.Prop[]): boolean {
  return a.length === b.length && isPrefix(a, b);
}

function getAt(root: unknown, path: readonly A.Prop[]): unknown {
  let at: unknown = root;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<A.Prop, unknown>)[key];
  }
  return at;
}

// Put `value` (or remove, when `removes`) at `path` inside an Automerge change,
// unless it's there already. A string over a string is updated in place, so
// the overlay doc's text keeps its identity. Returns why it couldn't, if it
// couldn't.
function putAt(
  doc: unknown,
  path: readonly A.Prop[],
  removes: boolean,
  value: unknown
): string | undefined {
  if (path.length === 0) return "empty-path";
  const parent = getAt(doc, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") return "no-parent";
  const key = path[path.length - 1];
  const target = parent as Record<A.Prop, unknown>;
  const current = target[key];
  try {
    if (removes) {
      if (current === undefined) return;
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete target[key];
      }
      return;
    }
    if (deepEqual(current, value)) return;
    if (typeof value === "string" && typeof current === "string") {
      A.updateText(doc as A.Doc<unknown>, [...path], value);
    } else {
      target[key] = plain(value);
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return;
}

// A fresh copy of a value read out of an Automerge document, so it can be
// written into another one.
function plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return value.slice();
  if (A.isCounter(value)) return new A.Counter(value.value);
  if (A.isImmutableString(value)) return new A.ImmutableString(value.val);
  if (Array.isArray(value)) return value.map(plain);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = plain(v);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (A.isCounter(a) || A.isCounter(b)) {
    return A.isCounter(a) && A.isCounter(b) && a.value === b.value;
  }
  if (A.isImmutableString(a) || A.isImmutableString(b)) {
    return A.isImmutableString(a) && A.isImmutableString(b) && a.val === b.val;
  }
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((x, i) => x === b[i])
    );
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )
  );
}
