import { afterEach, describe, expect, it, vi } from "vitest";
import { importPackageFromHttpUrl } from "../src/packages.js";

function dataModule(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("package imports", () => {
  it("uses importShim when available", async () => {
    const importShim = vi.fn(async () => ({ via: "importShim" }));
    vi.stubGlobal("importShim", importShim);

    const moduleUrl = dataModule("export const via = 'dynamic-import'");
    const mod = await importPackageFromHttpUrl(moduleUrl);

    expect(importShim).toHaveBeenCalledWith(moduleUrl);
    expect(mod).toEqual({ via: "importShim" });
  });

  it("retries a failed importShim load under a fresh url", async () => {
    const moduleUrl = dataModule("export const via = 'dynamic-import'");
    const importShim = vi
      .fn()
      .mockRejectedValueOnce(new Error("first load failed"))
      .mockResolvedValueOnce({ via: "retry" });
    vi.stubGlobal("importShim", importShim);

    const mod = await importPackageFromHttpUrl(moduleUrl);

    expect(importShim).toHaveBeenNthCalledWith(1, moduleUrl);
    expect(importShim).toHaveBeenNthCalledWith(2, `${moduleUrl}?retry=1`);
    expect(mod).toEqual({ via: "retry" });
  });
});
