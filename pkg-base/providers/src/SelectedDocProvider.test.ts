import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subscribe } from "@inkandswitch/patchwork-providers";

import { SelectedDocProvider } from "./SelectedDocProvider.js";

const APPLES = "automerge:2mDZ9pGrXdh1D8hZ7eHnm2wQ2uWH";

// hashchange is dispatched on a timer.
const go = async (hash: string) => {
  location.hash = hash;
  await new Promise((resolve) => setTimeout(resolve, 10));
};

let host: HTMLElement;
let child: HTMLElement;
let stop: () => void;

beforeEach(async () => {
  await go("");
  host = document.createElement("div");
  child = document.createElement("div");
  host.append(child);
  document.body.append(host);
  stop = SelectedDocProvider(host);
});

afterEach(() => {
  stop();
  host.remove();
});

describe("SelectedDocProvider", () => {
  it("selects the hash's document", async () => {
    const seen: unknown[] = [];
    subscribe(child, { type: "patchwork:selected-doc" }, (urls) =>
      seen.push(urls)
    );
    await go(`doc=${APPLES}`);
    expect(seen.at(-1)).toEqual([APPLES]);
  });

  it("selects nothing when the hash goes back to no document", async () => {
    const views: unknown[] = [];
    const docs: unknown[] = [];
    subscribe(child, { type: "patchwork:selected-view" }, (view) =>
      views.push(view)
    );
    subscribe(child, { type: "patchwork:selected-doc" }, (urls) =>
      docs.push(urls)
    );
    await go(`doc=${APPLES}`);
    expect(views.at(-1)).toEqual({ url: APPLES, toolId: null });
    await go("");
    expect(views.at(-1)).toBe(null);
    expect(docs.at(-1)).toEqual([]);
  });
});
