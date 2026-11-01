import * as A from "@automerge/automerge";
import { type DocHandle, Repo } from "@automerge/automerge-repo";

import { UndoHistory, type UndoHistoryOptions } from "../src/history.js";

export type Clock = { now: () => number; advance: (ms: number) => void };

export function clock(): Clock {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

export type Peer<T> = {
  handle: DocHandle<T>;
  history: UndoHistory;
  clock: Clock;
  doc: () => A.Doc<T>;
  change: (fn: A.ChangeFn<T>) => void;
};

/**
 * Two peers on one document, each in its own Repo and with its own actor
 * (`load(save(doc))`; `clone` would keep the actor, which silently breaks
 * "whose changes"). `sync()` merges each into the other.
 */
// One Repo for every peer: a Repo per peer holds a wasm Subduction instance
// each, and thousands of them (a long fuzz run) exhaust the wasm memory.
// The engine only cares about each document's actor.
let shared: Repo | undefined;

export function peers<T>(init: T, options: UndoHistoryOptions = {}) {
  const repo = (shared ??= new Repo());
  const make = (doc: A.Doc<T>): Peer<T> => {
    const handle = repo.create<T>();
    handle.update(() => doc);
    const c = clock();
    const history = new UndoHistory(handle as DocHandle<unknown>, {
      now: c.now,
      ...options,
    });
    return {
      handle,
      history,
      clock: c,
      doc: () => handle.doc() as A.Doc<T>,
      change: (fn) => {
        handle.change(fn);
        c.advance(1);
      },
    };
  };
  const base = A.from(init as Record<string, unknown>) as A.Doc<T>;
  const alice = make(A.load<T>(A.save(base)));
  const bob = make(A.load<T>(A.save(base)));
  const sync = () => {
    alice.handle.update((d) => A.merge(d, bob.doc()));
    bob.handle.update((d) => A.merge(d, alice.doc()));
  };
  /** Release both peers' documents and histories. */
  const dispose = () => {
    for (const p of [alice, bob]) {
      p.history.dispose();
      repo.delete(p.handle.documentId);
    }
  };
  return { alice, bob, sync, dispose };
}

/** A single peer, for tests that need no collaborator. */
export function solo<T>(init: T, options: UndoHistoryOptions = {}) {
  return peers(init, options).alice;
}

export const json = <T>(doc: A.Doc<T>) => JSON.parse(JSON.stringify(doc));
