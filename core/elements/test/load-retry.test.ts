import {
  Repo,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { registerRepoProviderElement } from "@inkandswitch/patchwork-providers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPatchworkViewElement } from "../src/patchwork-view.js";

let seq = 0;

function settle(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function docUrl(): AutomergeUrl {
  const bytes = new Uint8Array(32);
  bytes.fill((++seq % 250) + 1);
  return stringifyAutomergeUrl(bytes as never);
}

const tools = getRegistry("patchwork:tool");

describe("failed loads (legacy mode)", () => {
  // The backing repo the overlay resolves against: `find` fails until the
  // test says the doc has synced.
  const realRepo = new Repo();
  let available = false;
  let backing: DocHandle<unknown>;
  const find = vi.fn(async () => {
    if (!available) throw new Error("Document is unavailable");
    return backing;
  });
  const flakyRepo = {
    find,
    // What the overlay reads for a failure's verdict: unavailable until synced.
    query: () => {
      const state = () =>
        available
          ? { status: "ready", handle: backing }
          : { status: "unavailable" };
      return {
        state,
        subscribe: (listener: (s: unknown) => void) => {
          listener(state());
          return () => {};
        },
      };
    },
  } as unknown as Repo;
  registerRepoProviderElement(flakyRepo);

  const registered: string[] = [];
  afterEach(() => {
    // Gone before the next test, so no retry of theirs lands in it.
    document.body.replaceChildren();
    for (const id of registered) tools.remove(id);
    registered.length = 0;
  });

  // Nothing else brings the view back once the doc syncs: it has to try
  // again on its own.
  it("retries a failed load on a timer", async () => {
    const tag = `retry-legacy-${++seq}`;
    registerPatchworkViewElement({ name: tag, repo: flakyRepo });

    const toolId = `retry-tool-${++seq}`;
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
        supportedDatatypes: ["retry-type"],
        load: async () => render,
        module: render,
      } as never,
      `test://${toolId}`
    );
    registered.push(toolId);

    backing = await realRepo.create({ "@patchwork": { type: "retry-type" } });
    available = false;
    find.mockClear();

    const provider = document.createElement("repo-provider");
    const view = document.createElement(tag);
    view.setAttribute("doc-url", docUrl());
    provider.append(view);
    document.body.replaceChildren(provider);
    await vi.waitFor(() =>
      expect(view.querySelector(".pw-error")).toBeTruthy()
    );
    expect(find).toHaveBeenCalledTimes(1);

    available = true;
    await vi.waitFor(() => expect(tool.mounts).toBe(1), { timeout: 5_000 });
    expect(find).toHaveBeenCalledTimes(2);
    expect(view.querySelector(".pw-error")).toBeNull();

    // a mounted view stops retrying
    await settle(2200);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
