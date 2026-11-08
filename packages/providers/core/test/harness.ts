import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import { vi } from "vitest";

import {
  OverlayRepo,
  accept,
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "../src/index.js";

const teardowns: (() => void)[] = [];

/** Run every mount's teardown and empty the document; call from afterEach. */
export function unmountAll(): void {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.replaceChildren();
}

export type Mounted = {
  overlay: OverlayRepo;
  /** Answer `root`'s descriptor with `descriptor` from now on, re-answering live subscribers. */
  route(root: AutomergeUrl, descriptor: DocHandleDescriptor): void;
  /** Stop answering `root` at all: subscriptions stay open and unanswered. */
  silence(root: AutomergeUrl): void;
  /** Leases held minus released, per scratch url. */
  leases(url: AutomergeUrl): number;
  /** Total leases held minus released, over every url. */
  openLeases(): number;
  /** Live descriptor subscriptions, per root url. */
  subscribers(root: AutomergeUrl): number;
};

/**
 * remapper > consumer, with `overlay` asking from the consumer. Unrouted roots
 * are answered with themselves (what `<repo-provider>` does), so by default
 * the overlay is an identity remap over `repo`.
 */
export function mount(repo: Repo): Mounted {
  const remapper = document.createElement("div");
  const consumer = document.createElement("div");
  remapper.append(consumer);
  document.body.append(remapper);

  const routes = new Map<AutomergeUrl, DocHandleDescriptor | null>();
  const live = new Map<AutomergeUrl, Set<(d: DocHandleDescriptor) => void>>();
  const held = new Map<AutomergeUrl, number>();

  const answerFor = (root: AutomergeUrl) => {
    const routed = routes.get(root);
    return routed === undefined ? { url: root } : routed;
  };

  remapper.addEventListener("patchwork:subscribe", (event: SubscribeEvent) => {
    const { selector } = event.detail;
    if (selector.type === "repo:handle-descriptor") {
      const root = selector.url as AutomergeUrl;
      accept<DocHandleDescriptor>(event, (respond) => {
        let set = live.get(root);
        if (!set) live.set(root, (set = new Set()));
        set.add(respond);
        const answer = answerFor(root);
        if (answer) respond(answer);
        return () => set.delete(respond);
      });
    } else if (selector.type === "repo:scratch-lease") {
      const url = selector.url as AutomergeUrl;
      accept(event, () => {
        held.set(url, (held.get(url) ?? 0) + 1);
        return () => held.set(url, (held.get(url) ?? 0) - 1);
      });
    }
  });

  const overlay = new OverlayRepo(repo, consumer);
  teardowns.push(() => overlay.dispose());
  return {
    overlay,
    route(root, descriptor) {
      routes.set(root, descriptor);
      for (const respond of live.get(root) ?? []) respond(descriptor);
    },
    silence(root) {
      routes.set(root, null);
    },
    leases: (url) => held.get(url) ?? 0,
    openLeases: () => [...held.values()].reduce((a, b) => a + b, 0),
    subscribers: (root) => live.get(root)?.size ?? 0,
  };
}

/** Let MessageChannel hops and microtasks drain. */
export function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `handle` (an overlay handle) is backed by `backing`. */
export async function backedBy(
  handle: DocHandle<unknown>,
  backing: DocHandle<unknown>
): Promise<void> {
  await vi.waitFor(() => {
    const current = (handle as unknown as { backingHandle: DocHandle<unknown> })
      .backingHandle;
    if (current !== backing) throw new Error("not swapped yet");
  });
}

/** `url` with its documentId swapped for `documentId`, keeping path and heads. */
export function rebase(url: AutomergeUrl, onto: AutomergeUrl): AutomergeUrl {
  const { segments, heads } = parseAutomergeUrl(url);
  const { documentId } = parseAutomergeUrl(onto);
  return stringifyAutomergeUrl({ documentId, segments, heads });
}

/** Small seeded PRNG (mulberry32), so a failing fuzz run can be replayed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
