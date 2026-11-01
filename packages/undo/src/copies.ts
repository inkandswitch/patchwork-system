/**
 * Automerge can't undelete: a re-inserted element, a restored value or a
 * restored object is a *new* op with a new id. The inverse of a later step
 * still names the original ids, so every copy is recorded here and followed
 * whenever the inverse looks something up (as Yjs follows `redone` pointers).
 *
 * Several originals can map to one copy (a list element and the value ops
 * that overwrote it), so the reverse direction is a multimap.
 */
export class CopyMap {
  readonly #forward = new Map<string, string>();
  readonly #reverse = new Map<string, Set<string>>();

  /** Record that `original` now lives on as `copy`. */
  set(original: string, copy: string): void {
    if (original === copy) return;
    const previous = this.#forward.get(original);
    if (previous) this.#reverse.get(previous)?.delete(original);
    this.#forward.set(original, copy);
    let originals = this.#reverse.get(copy);
    if (!originals) this.#reverse.set(copy, (originals = new Set()));
    originals.add(original);
  }

  /** The newest copy of `id`, following copies of copies; `id` if none. */
  follow(id: string): string {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const next = this.#forward.get(current);
      if (next === undefined || seen.has(next)) return current;
      seen.add(current);
      current = next;
    }
  }

  /** Every id in `id`'s chain, starting with `id` itself. */
  chain(id: string): string[] {
    const out = [id];
    const seen = new Set(out);
    let current = id;
    for (;;) {
      const next = this.#forward.get(current);
      if (next === undefined || seen.has(next)) return out;
      out.push(next);
      seen.add(next);
      current = next;
    }
  }

  /** Every original `id` is a copy of, transitively, breadth-first. */
  originals(id: string): string[] {
    const out: string[] = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const original of this.#reverse.get(next) ?? []) {
        if (seen.has(original)) continue;
        seen.add(original);
        out.push(original);
        queue.push(original);
      }
    }
    return out;
  }

  clear(): void {
    this.#forward.clear();
    this.#reverse.clear();
  }
}
