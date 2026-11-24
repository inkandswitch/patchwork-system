import { describe, it, expect } from "vitest";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { resolvePath } from "../src/resolve.js";

const decode = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

function setup() {
  const repo = new Repo();
  const file = (content: string) =>
    repo.create({
      "@patchwork": { type: "file" },
      content,
      mimeType: "text/plain",
    }).url;
  const folder = (entries: Record<string, AutomergeUrl>) =>
    repo.create({
      "@patchwork": { type: "folder" },
      docs: Object.entries(entries).map(([name, url]) => ({
        name,
        type: "file",
        url,
      })),
    }).url;
  const account = (rest: object) =>
    repo.create<Record<string, unknown>>({
      "@patchwork": { type: "account" },
      ...rest,
    });
  const read = async (handle: ReturnType<typeof account>, path: string) => {
    const found = await resolvePath(repo, handle, path.split("/"));
    return found && decode(found.content);
  };
  return { file, folder, account, read };
}

describe("resolvePath through an account", () => {
  it("reads the root folder of an account with no namespace", async () => {
    const { file, folder, account, read } = setup();
    const handle = account({
      rootFolderUrl: folder({ notes: folder({ "a.txt": file("a") }) }),
    });
    expect(await read(handle, "notes/a.txt")).toBe("a");
    expect(await read(handle, "missing")).toBeUndefined();
  });

  it("reads a mount by its name, and everything else from /", async () => {
    const { file, folder, account, read } = setup();
    const handle = account({
      namespace: {
        "/": [{ url: folder({ "a.txt": file("root") }) }],
        "/packages": [{ url: folder({ "a.txt": file("package") }) }],
      },
    });
    expect(await read(handle, "a.txt")).toBe("root");
    expect(await read(handle, "packages/a.txt")).toBe("package");
  });

  it("a mount shadows a same-named entry in /", async () => {
    const { file, folder, account, read } = setup();
    const handle = account({
      namespace: {
        "/": [{ url: folder({ packages: folder({ "a.txt": file("root") }) }) }],
        "/packages": [{ url: folder({ "a.txt": file("mount") }) }],
      },
    });
    expect(await read(handle, "packages/a.txt")).toBe("mount");
  });

  it("reads a union through the first binding that has the name", async () => {
    const { file, folder, account, read } = setup();
    const handle = account({
      namespace: {
        "/packages": [
          { url: folder({ "a.txt": file("first") }) },
          { url: folder({ "a.txt": file("second"), "b.txt": file("b") }) },
        ],
      },
    });
    expect(await read(handle, "packages/a.txt")).toBe("first");
    expect(await read(handle, "packages/b.txt")).toBe("b");
    expect(await read(handle, "packages/c.txt")).toBeUndefined();
  });

  it("gives up on an account whose / is itself", async () => {
    const { account, read } = setup();
    const handle = account({});
    handle.change((doc) => {
      doc.rootFolderUrl = handle.url;
    });
    expect(await read(handle, "a.txt")).toBeUndefined();
  });
});
