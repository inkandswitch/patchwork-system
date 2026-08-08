import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPackageManifest } from "../src/manifest.js";

const AUTOMERGE_URL = "automerge:2uZrhZ7G2NJxryZSMWSdDNFCke8C";
const ORIGIN = "http://patchwork.test";

function stubFetch(bodies: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const body = bodies[String(input)];
      if (body === undefined) return { ok: false, status: 404 } as Response;
      return { ok: true, status: 200, json: async () => body } as Response;
    })
  );
}

beforeEach(() => {
  vi.stubGlobal("location", { origin: ORIGIN, href: `${ORIGIN}/` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPackageManifest", () => {
  it("resolves a relative import against an http package root", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": {
        manifest: 1,
        name: "Chat",
        plugins: [
          {
            id: "chat",
            type: "patchwork:tool",
            name: "Chat",
            import: "./dist/chat.js",
          },
        ],
        permissions: ["repo:read"],
      },
    });

    const pkg = await readPackageManifest("https://cdn.test/chat");

    expect(pkg).toMatchObject({
      url: "https://cdn.test/chat",
      base: "https://cdn.test/chat/",
      name: "Chat",
      permissions: ["repo:read"],
    });
    expect(pkg!.plugins[0].import).toBe("https://cdn.test/chat/dist/chat.js");
  });

  it("resolves an automerge package against the service worker origin", async () => {
    const base = `${ORIGIN}/${encodeURIComponent(AUTOMERGE_URL)}/`;
    stubFetch({
      [`${base}patchwork.json`]: {
        manifest: 1,
        plugins: [
          { id: "chat", type: "patchwork:tool", import: "./dist/chat.js" },
        ],
      },
    });

    const pkg = await readPackageManifest(AUTOMERGE_URL);

    expect(pkg!.base).toBe(base);
    expect(pkg!.plugins[0].import).toBe(`${base}dist/chat.js`);
  });

  it("takes an import through package.json exports when it names a subpath", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": {
        manifest: 1,
        plugins: [
          { id: "chat", type: "patchwork:tool", import: "./tool" },
          { id: "chat-data", type: "patchwork:datatype", import: "." },
        ],
      },
      "https://cdn.test/chat/package.json": {
        exports: {
          ".": { import: "./dist/index.js" },
          "./tool": {
            patchwork: "./dist/patchwork-tool.js",
            import: "./dist/tool.js",
          },
        },
      },
    });

    const pkg = await readPackageManifest("https://cdn.test/chat");

    expect(pkg!.plugins.map((p) => p.import)).toEqual([
      "https://cdn.test/chat/dist/patchwork-tool.js",
      "https://cdn.test/chat/dist/index.js",
    ]);
  });

  it("falls back to a relative path when exports has no such subpath", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": {
        manifest: 1,
        plugins: [
          { id: "chat", type: "patchwork:tool", import: "./dist/chat.js" },
        ],
      },
      "https://cdn.test/chat/package.json": {
        exports: { ".": "./dist/index.js" },
      },
    });

    const pkg = await readPackageManifest("https://cdn.test/chat");

    expect(pkg!.plugins[0].import).toBe("https://cdn.test/chat/dist/chat.js");
  });

  it("leaves an absolute import URL alone", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": {
        manifest: 1,
        plugins: [
          {
            id: "chat",
            type: "patchwork:tool",
            import: "https://elsewhere.test/chat.js",
          },
        ],
      },
    });

    const pkg = await readPackageManifest("https://cdn.test/chat");

    expect(pkg!.plugins[0].import).toBe("https://elsewhere.test/chat.js");
  });

  it("is undefined when there is no patchwork.json", async () => {
    stubFetch({});
    expect(await readPackageManifest("https://cdn.test/chat")).toBeUndefined();
  });

  it("rejects a manifest of an unknown version", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": { manifest: 2, plugins: [] },
    });
    await expect(readPackageManifest("https://cdn.test/chat")).rejects.toThrow(
      /unsupported manifest version 2/
    );
  });

  it("rejects a plugin with no import", async () => {
    stubFetch({
      "https://cdn.test/chat/patchwork.json": {
        manifest: 1,
        plugins: [{ id: "chat", type: "patchwork:tool" }],
      },
    });
    await expect(readPackageManifest("https://cdn.test/chat")).rejects.toThrow(
      /no import/
    );
  });
});
