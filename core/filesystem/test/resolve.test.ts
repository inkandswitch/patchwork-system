import { describe, it, expect } from "vitest";
import { ImmutableString } from "@automerge/automerge";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { packageDocuments, resolvePath } from "../src/resolve.js";

const decode = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

// A package the way pushwork writes one: a directory doc of path → file doc
// url, where the link may be a plain string or an ImmutableString.
function publish(repo: Repo, link: (url: AutomergeUrl) => unknown) {
  const file = (name: string, content: string, mimeType: string) =>
    repo.create({ "@patchwork": { type: "file" }, name, content, mimeType })
      .url;
  const pkg = file("package.json", '{"main":"dist/index.js"}', "application/json");
  const index = file("index.js", "export default 1", "text/javascript");
  const root = repo.create<Record<string, unknown>>({
    "@patchwork": { type: "directory" },
  });
  root.change((d) => {
    d["package.json"] = link(pkg);
    d["dist/index.js"] = link(index);
  });
  return root;
}

describe("resolvePath", () => {
  for (const [name, link] of [
    ["string", (url: AutomergeUrl) => url],
    ["ImmutableString", (url: AutomergeUrl) => new ImmutableString(url)],
  ] as const) {
    it(`follows ${name} links in a directory doc`, async () => {
      const repo = new Repo();
      const root = publish(repo, link);

      const pkg = await resolvePath(repo, root, ["package.json"]);
      expect(pkg?.type).toBe("application/json");
      expect(decode(pkg!.content)).toBe('{"main":"dist/index.js"}');

      const index = await resolvePath(repo, root, ["dist", "index.js"]);
      expect(index?.type).toBe("text/javascript");
      expect(decode(index!.content)).toBe("export default 1");

      expect(await resolvePath(repo, root, ["missing.js"])).toBeUndefined();
    });
  }

  it("follows ImmutableString links in a folder doc", async () => {
    const repo = new Repo();
    const file = repo.create({
      content: "hello",
      mimeType: "text/plain",
    });
    const folder = repo.create({
      title: "folder",
      docs: [{ name: "hello.txt", type: "file", url: new ImmutableString(file.url) }],
    });
    const hello = await resolvePath(repo, folder, ["hello.txt"]);
    expect(hello && decode(hello.content)).toBe("hello");
  });
});

describe("packageDocuments", () => {
  const paths = async (repo: Repo, root: Parameters<typeof packageDocuments>[1]) => {
    const found: string[] = [];
    for await (const { path } of packageDocuments(repo, root)) found.push(path);
    return found;
  };

  it("finds every document in a directory doc, once each", async () => {
    const repo = new Repo();
    const root = publish(repo, (url) => new ImmutableString(url));
    // a second key linking the same file isn't a second document
    root.change((d) => {
      d["dist/again.js"] = d["dist/index.js"];
    });
    expect(await paths(repo, root)).toEqual(["", "package.json", "dist/index.js"]);
  });

  it("follows folder docs into their subfolders", async () => {
    const repo = new Repo();
    const file = (content: string) => repo.create({ content, mimeType: "text/plain" }).url;
    const sub = repo.create({
      title: "dist",
      docs: [{ name: "index.js", type: "file", url: file("1") }],
    });
    const root = repo.create<{ title: string; docs: unknown[] }>({
      title: "pkg",
      docs: [
        { name: "package.json", type: "file", url: file("{}") },
        { name: "dist", type: "folder", url: new ImmutableString(sub.url) },
      ],
    });
    // a cycle back to the root is ignored
    sub.change((d: any) => {
      d.docs.push({ name: "up", type: "folder", url: root.url });
    });
    expect(await paths(repo, root)).toEqual([
      "",
      "package.json",
      "dist",
      "dist/index.js",
    ]);
  });

  it("hands back a document it can't find, and goes on", async () => {
    const repo = new Repo();
    const root = publish(repo, (url) => url);
    const missing = "automerge:4ZTwsiaeyyK6BwDipkqpJwygKScz" as AutomergeUrl;
    root.change((d) => {
      d["art/missing.png"] = missing;
    });
    const missingRepo: Repo = Object.create(repo, {
      find: {
        value: (url: AutomergeUrl) =>
          url === missing
            ? Promise.reject(new Error("unavailable"))
            : repo.find(url),
      },
    });
    const found = [];
    for await (const document of packageDocuments(missingRepo, root)) {
      found.push([document.path, "error" in document]);
    }
    expect(found).toEqual([
      ["", false],
      ["package.json", false],
      ["dist/index.js", false],
      ["art/missing.png", true],
    ]);
  });
});
