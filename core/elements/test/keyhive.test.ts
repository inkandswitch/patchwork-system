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
    await settle();
    expect(component.mounts).toBe(0);

    fake.setAccess(true);
    fake.ingest();
    await settle();
    expect(component.mounts).toBe(1);
  });

  it("unmounts when access is revoked", async () => {
    setup(true);
    const component = registerComponent();
    mount(component.id, keyhiveUrl());
    await settle();
    expect(component.mounts).toBe(1);

    fake.setAccess(false);
    fake.ingest();
    await settle();
    expect(component.cleanups).toBe(1);
  });

  it("checks access once per burst for every view of a doc", async () => {
    setup(true);
    const component = registerComponent();
    const url = keyhiveUrl();
    for (let i = 0; i < 3; i++) mount(component.id, url);
    await settle();
    expect(component.mounts).toBe(3);
    expect(fake.listeners.size).toBe(1);

    fake.accessForDoc.mockClear();
    for (let i = 0; i < 5; i++) fake.ingest();
    await settle();
    expect(fake.accessForDoc).toHaveBeenCalledTimes(1);
  });

  it("doesn't watch legacy docs", async () => {
    setup(true);
    const component = registerComponent();
    const legacyUrl = new Repo({}).create({}).url;
    mount(component.id, legacyUrl);
    await settle();
    expect(component.mounts).toBe(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("stops watching once every view is gone", async () => {
    setup(false);
    const component = registerComponent();
    const url = keyhiveUrl();
    const views = [mount(component.id, url), mount(component.id, url)];
    await settle();
    expect(fake.listeners.size).toBe(1);

    for (const view of views) view.remove();
    await settle();
    expect(fake.listeners.size).toBe(0);
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
    await settle();

    const error = view.querySelector(".pw-error");
    expect(error).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);

    // Still unavailable: retried, but the error the reader is looking at stays
    // put rather than being torn down and faded back in.
    fake.ingest();
    // Past the 300ms the old retry path slept before rebuilding the view.
    await settle(400);
    expect(find).toHaveBeenCalledTimes(2);
    expect(view.querySelector(".pw-error")).toBe(error);

    available = true;
    fake.ingest();
    await settle();
    expect(tool.mounts).toBe(1);
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
    await settle();
    expect(view.querySelector(".pw-error")).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);

    let rejectRetry!: (reason?: unknown) => void;
    find.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        })
    );
    fake.ingest();
    await settle();
    expect(find).toHaveBeenCalledTimes(2);

    available = true;
    fake.ingest();
    await settle();
    rejectRetry(new Error("Document is still unavailable"));
    await settle();

    expect(find).toHaveBeenCalledTimes(3);
    expect(tool.mounts).toBe(1);
    expect(view.querySelector(".pw-error")).toBeNull();
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
    await settle();
    expect(view.querySelector(".pw-error")).toBeTruthy();
    expect(find).toHaveBeenCalledTimes(1);

    // the doc syncs, and no keyhive op follows
    available = true;
    await settle(1200);
    expect(find).toHaveBeenCalledTimes(2);
    expect(tool.mounts).toBe(1);
    expect(view.querySelector(".pw-error")).toBeNull();

    // a mounted view stops retrying
    await settle(2200);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
