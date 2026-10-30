import { describe, it, expect } from "vitest";
import { ImmutableString } from "@automerge/automerge";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { resolvePath } from "../src/resolve.js";

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

  it("follows a branches doc's default branch", async () => {
    const repo = new Repo();
    const pkg = publish(repo, (url) => url);
    const branches = repo.create({
      "@patchwork": { type: "branches" },
      branches: { default: pkg.url },
    });
    const index = await resolvePath(repo, branches, ["dist", "index.js"]);
    expect(index && decode(index.content)).toBe("export default 1");
  });

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
