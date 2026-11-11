import { beforeEach, describe, expect, it, vi } from "vitest";

const { importPackageFromHttpUrl } = vi.hoisted(() => ({
  importPackageFromHttpUrl: vi.fn(),
}));

vi.mock("@inkandswitch/patchwork-filesystem", () => ({
  importPackageFromHttpUrl,
}));

import { discoverHttpPlugins } from "./discover-plugins.ts";

describe("discoverHttpPlugins", () => {
  beforeEach(() => {
    importPackageFromHttpUrl.mockReset();
  });

  it("imports HTTP packages through the host package importer", async () => {
    importPackageFromHttpUrl.mockResolvedValue({
      plugins: [{ id: "example", load: () => {} }],
    });

    await expect(
      discoverHttpPlugins("https://example.com/package/")
    ).resolves.toEqual([{ id: "example" }]);
    expect(importPackageFromHttpUrl).toHaveBeenCalledWith(
      "https://example.com/package/"
    );
  });
});
