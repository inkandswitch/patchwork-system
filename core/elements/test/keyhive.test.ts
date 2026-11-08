import {
  Repo,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import type { AutomergeRepoKeyhiveBase } from "@automerge/automerge-repo-keyhive";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPatchworkViewElement,
  type ComponentDescription,
} from "../src/patchwork-view.js";

type Counters = { mounts: number; cleanups: number };

let seq = 0;

function settle(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for the view to have heard `times` access checks: an ingest reaches
// it through a macrotask, then `accessForDoc`, then microtasks after that.
async function heard(
  fake: { accessForDoc: ReturnType<typeof vi.fn> },
  times: number
) {
  await vi.waitFor(() =>
    expect(fake.accessForDoc).toHaveBeenCalledTimes(times)
  );
  await settle(0);
}

// A keyhive document id is 32 bytes with something in the back half; the
// padded-zero 16-byte ids `Repo.create` hands out are legacy docs.
function keyhiveUrl(): AutomergeUrl {
  const bytes = new Uint8Array(32);
  bytes.fill((++seq % 250) + 1);
  return stringifyAutomergeUrl(bytes as never);
}

/** Just enough of `AutomergeRepoKeyhive` for the views' access gate. */
function fakeHive(initialAccess: boolean) {
  let access = initialAccess;
  const listeners = new Set<() => void>();
  const accessForDoc = vi.fn(async () =>
    access ? { toString: () => "Read" } : undefined
  );
  const hive = {
    active: { individual: { id: "me" } },
    accessForDoc,
    networkAdapter: {
      on: (_event: string, listener: () => void) => listeners.add(listener),
      off: (_event: string, listener: () => void) => listeners.delete(listener),
    },
  } as unknown as AutomergeRepoKeyhiveBase;
  return {
    hive,
    accessForDoc,
    listeners,
    setAccess(value: boolean) {
      access = value;
    },
    /** Keyhive ingested a remote op (a burst of them, if called repeatedly). */
    ingest() {
      for (const listener of [...listeners]) listener();
    },
  };
}

const components = getRegistry<ComponentDescription>("patchwork:component");
const tools = getRegistry("patchwork:tool");

function registerComponent(): Counters & { id: string } {
  const id = `kh-component-${++seq}`;
  const counters = { id, mounts: 0, cleanups: 0 };
  const render = () => {
    counters.mounts++;
    return () => {
      counters.cleanups++;
    };
  };
  components.register(
    {
      id,
      type: "patchwork:component",
      name: id,
      load: async () => render,
      module: render,
    } as never,
    `test://${id}`
  );
  return counters;
}

describe("keyhive access (component mode)", () => {
  // Component mode waits for a keyhive doc to be ready on the base repo.
  const readyRepo = {
    findWithProgress: () => ({
      peek: () => ({ state: "ready" }),
      subscribe: () => () => {},
    }),
  } as unknown as Repo;

  let fake: ReturnType<typeof fakeHive>;
  let tag: string;

  function setup(access: boolean) {
    fake = fakeHive(access);
    tag = `kh-view-${++seq}`;
    registerPatchworkViewElement({ name: tag, repo: readyRepo, hive: fake.hive });
  }

  function mount(component: string, url: AutomergeUrl) {
    const view = document.createElement(tag);
    view.setAttribute("component", component);
    view.setAttribute("url", url);
    document.body.append(view);
    return view;
  }

  beforeEach(() => document.body.replaceChildren());

  it("mounts once access arrives", async () => {
    setup(false);
    const component = registerComponent();
    mount(component.id, keyhiveUrl());
    await heard(fake, 1);
    expect(component.mounts).toBe(0);

    fake.setAccess(true);
    fake.ingest();
    await vi.waitFor(() => expect(component.mounts).toBe(1));
  });

  it("unmounts when access is revoked", async () => {
    setup(true);
    const component = registerComponent();
    mount(component.id, keyhiveUrl());
    await vi.waitFor(() => expect(component.mounts).toBe(1));

    fake.setAccess(false);
    fake.ingest();
    await vi.waitFor(() => expect(component.cleanups).toBe(1));
  });

  it("checks access once per burst for every view of a doc", async () => {
    setup(true);
    const component = registerComponent();
    const url = keyhiveUrl();
    for (let i = 0; i < 3; i++) mount(component.id, url);
    await vi.waitFor(() => expect(component.mounts).toBe(3));
    expect(fake.listeners.size).toBe(1);

    fake.accessForDoc.mockClear();
    for (let i = 0; i < 5; i++) fake.ingest();
    await heard(fake, 1);
    await settle();
    expect(fake.accessForDoc).toHaveBeenCalledTimes(1);
  });

  it("doesn't watch legacy docs", async () => {
    setup(true);
    const component = registerComponent();
    const legacyUrl = new Repo({}).create({}).url;
    mount(component.id, legacyUrl);
    await vi.waitFor(() => expect(component.mounts).toBe(1));
    expect(fake.listeners.size).toBe(0);
  });

  it("stops watching once every view is gone", async () => {
    setup(false);
    const component = registerComponent();
    const url = keyhiveUrl();
    const views = [mount(component.id, url), mount(component.id, url)];
    await vi.waitFor(() => expect(fake.listeners.size).toBe(1));

    for (const view of views) view.remove();
    await vi.waitFor(() => expect(fake.listeners.size).toBe(0));
  });
});

describe("keyhive access (legacy mode)", () => {
  // The backing repo the overlay resolves against: `find` fails until the
  // test says the doc has synced.
  const realRepo = new Repo({});
  let available = false;
  let backing: DocHandle<unknown>;
  const find = vi.fn(async () => {
    if (!available) throw new Error("Document is unavailable");
    return backing;
  });
  const flakyRepo = {
    find,
    findWithProgress: () => ({
      peek: () => ({ state: "loading" }),
      subscribe: () => () => {},
    }),
  } as unknown as Repo;
  registerRepoProviderElement(flakyRepo);

  const registered: string[] = [];
  afterEach(() => {
    // Gone before the next test, so no retry of theirs lands in it.
    document.body.replaceChildren();
    for (const id of registered) tools.remove(id);
    registered.length = 0;
  });

  it("retries a failed load in place instead of rebuilding the view", async () => {
    const fake = fakeHive(true);
    const tag = `kh-legacy-${++seq}`;
    registerPatchworkViewElement({ name: tag, repo: flakyRepo, hive: fake.hive });

    const toolId = `kh-tool-${++seq}`;
    const tool = { mounts: 0 };
    const render = () => {
      tool.mounts++;
      return () => {};
    };
    tools.register(
      {
        id: toolId,
        type: "patchwork:tool",
        name: toolId,
        supportedDatatypes: ["kh-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    backing = realRepo.create({ "@patchwork": { type: "kh-type" } });
    available = false;
    find.mockClear();

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", keyhiveUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );
    const error = view.querySelector(".pw-error");
    expect(find).toHaveBeenCalledTimes(1);

    // Still unavailable: retried, but the error the reader is looking at stays
    // put rather than being torn down and faded back in.
    fake.ingest();
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    // Past the 300ms the old retry path slept before rebuilding the view.
    await settle(400);
    expect(find).toHaveBeenCalledTimes(2);
    expect(view.querySelector(".pw-error")).toBe(error);

    available = true;
    fake.ingest();
    await vi.waitFor(() => expect(tool.mounts).toBe(1));
    expect(view.querySelector(".pw-error")).toBeNull();
  });

  it("retries after an ingest arrives during a failed lookup", async () => {
    const fake = fakeHive(true);
    const tag = `kh-legacy-${++seq}`;
    registerPatchworkViewElement({
      name: tag,
      repo: flakyRepo,
      hive: fake.hive,
    });

    const toolId = `kh-tool-${++seq}`;
    const tool = { mounts: 0 };
    const render = () => {
      tool.mounts++;
      return () => {};
    };
    tools.register(
      {
        id: toolId,
        type: "patchwork:tool",
        name: toolId,
        supportedDatatypes: ["kh-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    backing = realRepo.create({ "@patchwork": { type: "kh-type" } });
    available = false;
    find.mockClear();

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", keyhiveUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );
    expect(find).toHaveBeenCalledTimes(1);

    let rejectRetry!: (reason?: unknown) => void;
    find.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        })
    );
    fake.ingest();
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));

    available = true;
    fake.ingest();
    await heard(fake, 3);
    rejectRetry(new Error("Document is still unavailable"));
    await vi.waitFor(() => expect(tool.mounts).toBe(1));

    expect(find).toHaveBeenCalledTimes(3);
    expect(view.querySelector(".pw-error")).toBeNull();
  });

  it("doesn't mount a retry after access is revoked", async () => {
    const fake = fakeHive(true);
    const tag = `kh-legacy-${++seq}`;
    registerPatchworkViewElement({
      name: tag,
      repo: flakyRepo,
      hive: fake.hive,
    });

    const toolId = `kh-tool-${++seq}`;
    const tool = { mounts: 0 };
    const render = () => {
      tool.mounts++;
      return () => {};
    };
    tools.register(
      {
        id: toolId,
        type: "patchwork:tool",
        name: toolId,
        supportedDatatypes: ["kh-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    backing = realRepo.create({ "@patchwork": { type: "kh-type" } });
    available = false;
    find.mockClear();

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", keyhiveUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );
    expect(find).toHaveBeenCalledTimes(1);

    let resolveRetry!: (handle: DocHandle<unknown>) => void;
    find.mockImplementationOnce(
      () =>
        new Promise<DocHandle<unknown>>((resolve) => {
          resolveRetry = resolve;
        })
    );
    fake.ingest();
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));

    fake.setAccess(false);
    fake.ingest();
    // the revocation restarted the view, whose own check found no access
    await heard(fake, 4);
    resolveRetry(backing);
    await settle();

    expect(fake.accessForDoc).toHaveBeenCalledTimes(4);
    expect(tool.mounts).toBe(0);
  });

  // The grant's op can be the last one for a while, and land before the doc
  // is fetchable: the view has to try again on its own.
  it("retries a failed load on a timer when no op comes", async () => {
    const fake = fakeHive(true);
    const tag = `kh-legacy-${++seq}`;
    registerPatchworkViewElement({ name: tag, repo: flakyRepo, hive: fake.hive });

    const toolId = `kh-tool-${++seq}`;
    const tool = { mounts: 0 };
    const render = () => {
      tool.mounts++;
      return () => {};
    };
    tools.register(
      {
        id: toolId,
        type: "patchwork:tool",
        name: toolId,
        supportedDatatypes: ["kh-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    backing = realRepo.create({ "@patchwork": { type: "kh-type" } });
    available = false;
    find.mockClear();

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", keyhiveUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );
    expect(find).toHaveBeenCalledTimes(1);

    // the doc syncs, and no keyhive op follows
    available = true;
    await vi.waitFor(() => expect(tool.mounts).toBe(1), { timeout: 5_000 });
    expect(find).toHaveBeenCalledTimes(2);
    expect(view.querySelector(".pw-error")).toBeNull();

    // a mounted view stops retrying
    await settle(2200);
    expect(find).toHaveBeenCalledTimes(2);
  });

  // An unavailable query answers `find` from its verdict without asking the
  // server again, so the timer has to re-arm the sync before it looks.
  it("asks the sync server again before each timed retry", async () => {
    const fake = fakeHive(true);
    const tag = `kh-legacy-${++seq}`;

    const toolId = `kh-tool-${++seq}`;
    const tool = { mounts: 0 };
    const render = () => {
      tool.mounts++;
      return () => {};
    };
    tools.register(
      {
        id: toolId,
        type: "patchwork:tool",
        name: toolId,
        supportedDatatypes: ["kh-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    const handle = realRepo.create({ "@patchwork": { type: "kh-type" } });
    // like the real repo: once unavailable, `find` rejects straight away
    // until something re-arms the sync, and a re-armed sync only finds the
    // doc if the server has it by then
    let state: "unavailable" | "loading" = "unavailable";
    let serverHasIt = false;
    const listeners = new Set<(p: { state: string }) => void>();
    const setState = (next: typeof state) => {
      state = next;
      for (const listener of [...listeners]) listener({ state });
    };
    const resyncSubduction = vi.fn(() => {
      setTimeout(() => setState("loading"), 0);
    });
    const verdictRepo = {
      find: vi.fn(async () => {
        if (state === "unavailable")
          throw new Error("Document is unavailable");
        if (!serverHasIt) {
          setState("unavailable");
          throw new Error("Document is unavailable");
        }
        return handle;
      }),
      findWithProgress: () => ({
        peek: () => ({ state }),
        subscribe: (listener: (p: { state: string }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      resyncSubduction,
    } as unknown as Repo;
    registerPatchworkViewElement({ name: tag, repo: verdictRepo, hive: fake.hive });

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", keyhiveUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );

    // the sender's device pushes it to the server; nothing tells us
    serverHasIt = true;
    await vi.waitFor(() => expect(tool.mounts).toBe(1), { timeout: 5_000 });
    expect(resyncSubduction).toHaveBeenCalledTimes(1);
    expect(view.querySelector(".pw-error")).toBeNull();
  });
});

// A failed load of a keyhive doc used to leave the view blank until reload.
describe("failed loads (component mode)", () => {
  type Progress = {
    peek: () => { state: string; error?: Error };
    subscribe: (cb: (s: { state: string; error?: Error }) => void) => () => void;
  };

  let current: { state: string; error?: Error };
  let listeners: Set<(s: { state: string; error?: Error }) => void>;
  let findWithProgress: ReturnType<typeof vi.fn>;
  let resyncSubduction: ReturnType<typeof vi.fn>;
  let tag: string;
  let component: ReturnType<typeof registerComponent>;

  function setState(next: { state: string; error?: Error }) {
    current = next;
    for (const listener of [...listeners]) listener(next);
  }

  function setup(initial: { state: string; error?: Error }) {
    current = initial;
    listeners = new Set();
    findWithProgress = vi.fn(
      (): Progress => ({
        peek: () => current,
        subscribe: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      })
    );
    resyncSubduction = vi.fn();
    const repo = { findWithProgress, resyncSubduction } as unknown as Repo;
    tag = `kh-failed-${++seq}`;
    registerPatchworkViewElement({
      name: tag,
      repo,
      hive: fakeHive(true).hive,
    });
    component = registerComponent();
  }

  function mount() {
    const view = document.createElement(tag);
    view.setAttribute("component", component.id);
    view.setAttribute("url", keyhiveUrl());
    document.body.append(view);
    return view;
  }

  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a failure seen on the first look, and mounts once it loads", async () => {
    setup({ state: "failed", error: new Error("nope") });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(component.mounts).toBe(0);
    expect(findWithProgress).toHaveBeenCalledTimes(1);

    current = { state: "ready" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(findWithProgress).toHaveBeenCalledTimes(2);
    expect(component.mounts).toBe(1);

    // a mounted view stops retrying
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findWithProgress).toHaveBeenCalledTimes(2);
  });

  it("retries a failure that arrives while waiting", async () => {
    setup({ state: "loading" });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    setState({ state: "failed", error: new Error("later") });
    await vi.advanceTimersByTimeAsync(0);
    expect(component.mounts).toBe(0);

    current = { state: "ready" };
    await vi.advanceTimersByTimeAsync(1000);
    expect(component.mounts).toBe(1);
  });

  it("backs off, resyncs before each retry, and starts over after a success", async () => {
    setup({ state: "failed", error: new Error("nope") });
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(resyncSubduction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(findWithProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(findWithProgress).toHaveBeenCalledTimes(2);

    // the second failure waits twice as long
    await vi.advanceTimersByTimeAsync(1999);
    expect(findWithProgress).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(findWithProgress).toHaveBeenCalledTimes(3);
    expect(resyncSubduction).toHaveBeenCalledTimes(3);

    // a success resets the count: the next failure waits the first delay again
    current = { state: "ready" };
    await vi.advanceTimersByTimeAsync(4000);
    expect(component.mounts).toBe(1);
    current = { state: "failed", error: new Error("again") };
    view.setAttribute("url", keyhiveUrl());
    await vi.advanceTimersByTimeAsync(0);
    findWithProgress.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(findWithProgress).toHaveBeenCalledTimes(1);
  });

  it("retries an unavailable doc on the timer until it is ready", async () => {
    setup({ state: "unavailable" });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(component.mounts).toBe(0);
    expect(resyncSubduction).toHaveBeenCalledTimes(1);

    // the resync puts the query back to loading, which doesn't cancel the timer
    setState({ state: "loading" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(findWithProgress).toHaveBeenCalledTimes(2);
    expect(component.mounts).toBe(0);

    // the round finds nothing, so the restarted view hears unavailable again
    // and waits the longer delay
    setState({ state: "unavailable" });
    current = { state: "ready" };
    await vi.advanceTimersByTimeAsync(2000);
    expect(component.mounts).toBe(1);
  });

  it("restarts once, and drops the timer, when ready beats it", async () => {
    setup({ state: "loading" });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    setState({ state: "unavailable" });
    expect(vi.getTimerCount()).toBe(1);

    current = { state: "ready" };
    setState({ state: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    expect(component.mounts).toBe(1);
    expect(findWithProgress).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(findWithProgress).toHaveBeenCalledTimes(2);
    expect(component.mounts).toBe(1);
  });

  it("stops retrying when the view is removed", async () => {
    setup({ state: "failed", error: new Error("nope") });
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    view.remove();
    await vi.advanceTimersByTimeAsync(0);
    findWithProgress.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(findWithProgress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
