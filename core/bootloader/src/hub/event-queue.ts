// A session's events, as a tab hands them on to its Repo.

import type { SedimentreeEvent } from "@automerge/automerge-repo/sedimentree";

/** An async iterable fed from outside, ending or failing once. */
export class EventQueue<T = SedimentreeEvent> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiting: {
    resolve(r: IteratorResult<T>): void;
    reject(e: unknown): void;
  }[] = [];
  #done = false;
  #error: { error: unknown } | undefined;

  push(item: T): void {
    if (this.#done) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiting.splice(0)) {
      w.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#done) return;
    this.#error = { error };
    this.#done = true;
    for (const w of this.#waiting.splice(0)) w.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length) {
          return Promise.resolve({ value: this.#items.shift()!, done: false });
        }
        if (this.#error) return Promise.reject(this.#error.error);
        if (this.#done)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          this.#waiting.push({ resolve, reject })
        );
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
