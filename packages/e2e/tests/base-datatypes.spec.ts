import { expect, test } from "@playwright/test";
import {
  createDoc,
  findDocField,
  navigate,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

declare global {
  interface Window {
    Automerge: {
      splice: (
        doc: unknown,
        path: (string | number)[],
        index: number,
        del: number,
        text?: string,
      ) => void;
    };
  }
}

/**
 * Doc shapes from the real module collection (patchwork/base).
 *
 * The relay tests so far use ad-hoc shapes. These mirror what modules
 * actually store: a folder doc whose `docs` list references other docs by
 * url (folder/src/datatype.js), and a markdown doc whose `content` is
 * collaborative text edited with Automerge.splice
 * (codemirror-markdown/src/datatype.ts).
 */

test("a folder's doc references resolve across tabs", async ({ context }) => {
  const tabA = await context.newPage();
  await navigate(tabA, "/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await navigate(tabB, "/");
  await waitForRepoReady(tabB);

  const noteUrl = await createDoc(tabA, { content: "# Meeting notes" });
  const folderUrl = await createDoc(tabA, {
    title: "New Folder",
    docs: [{ type: "markdown", name: "Meeting notes", url: noteUrl }],
  });

  const entry = await tabB.evaluate(async (u) => {
    const folder = await window.repo.find<{
      docs: { type: string; name: string; url: string }[];
    }>(u);
    return folder.doc().docs[0];
  }, folderUrl);

  expect(entry).toEqual({
    type: "markdown",
    name: "Meeting notes",
    url: noteUrl,
  });

  const content = await findDocField<string>(tabB, entry.url, "content");
  expect(content).toBe("# Meeting notes");
});

test("concurrent text splices from two tabs converge", async ({ context }) => {
  const tabA = await context.newPage();
  await navigate(tabA, "/");
  await waitForServiceWorkerActive(tabA);
  await waitForRepoReady(tabA);

  const tabB = await context.newPage();
  await navigate(tabB, "/");
  await waitForRepoReady(tabB);

  const url = await createDoc(tabA, { content: "# Untitled\n" });
  await expect
    .poll(async () => findDocField<string>(tabB, url, "content"), {
      timeout: 15_000,
    })
    .toBe("# Untitled\n");

  const spliceAtEnd = (tab: typeof tabA, text: string) =>
    tab.evaluate(
      async ([u, t]) => {
        const handle = await window.repo.find<{ content: string }>(u);
        handle.change((d) => {
          window.Automerge.splice(d, ["content"], d.content.length, 0, t);
        });
      },
      [url, text] as const,
    );

  await Promise.all([
    spliceAtEnd(tabA, "line from A\n"),
    spliceAtEnd(tabB, "line from B\n"),
  ]);

  const converged = async (tab: typeof tabA) =>
    findDocField<string>(tab, url, "content");

  for (const tab of [tabA, tabB]) {
    await expect
      .poll(async () => {
        const content = await converged(tab);
        return (
          content.includes("line from A\n") && content.includes("line from B\n")
        );
      }, { timeout: 15_000 })
      .toBe(true);
  }

  const [contentA, contentB] = await Promise.all([
    converged(tabA),
    converged(tabB),
  ]);
  expect(contentA).toBe(contentB);
  expect(contentA.startsWith("# Untitled\n")).toBe(true);
});
