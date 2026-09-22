import { expect, test, type Page } from "@playwright/test";
import { awaitField, online, openTab, record, setField, type Mode } from "./bench.js";

const mode: Mode = "pertab-mesh";
const TEXT_BYTES = 1 << 20;
const EDIT_TIMEOUT_MS = 5_000;

async function jsAndWasmMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.detach();
  return page.evaluate(async () => {
    const { breakdown } = (await (
      performance as unknown as {
        measureUserAgentSpecificMemory(): Promise<{
          breakdown: { bytes: number; types: string[] }[];
        }>;
      }
    ).measureUserAgentSpecificMemory());
    let bytes = 0;
    for (const entry of breakdown) {
      if (
        entry.types.includes("JavaScript") ||
        entry.types.includes("WebAssembly")
      ) {
        bytes += entry.bytes;
      }
    }
    return bytes / 1_048_576;
  });
}

test(`${mode}: evict a document, then find it again`, async ({ context }) => {
  const a = await openTab(context, mode);
  const b = await openTab(context, mode);
  await Promise.all([online(a), online(b)]);

  const { url, documentId, heads } = await a.evaluate((bytes) => {
    const handle = window.repo.create<{ text: string }>();
    handle.change((d) => {
      d.text = "x".repeat(bytes);
    });
    return {
      url: handle.url,
      documentId: handle.documentId,
      heads: [...handle.heads()].sort(),
    };
  }, TEXT_BYTES);
  await a.evaluate(() => window.repo.flush());
  const bHasText = await b.evaluate(
    async ([url, bytes]) => {
      const { handle } = await window.bench.find(url);
      return (handle.doc().text as string | undefined)?.length === bytes;
    },
    [url, TEXT_BYTES] as const
  );
  expect(bHasText).toBe(true);

  const before = await jsAndWasmMB(a);
  const gone = await a.evaluate(async (documentId) => {
    await window.repo.removeFromCache(documentId);
    return !Object.keys(window.repo.handles).includes(documentId);
  }, documentId);
  record({
    metric: "evict → documentId gone from repo.handles",
    mode,
    value: gone,
    unit: "ok",
  });
  expect.soft(gone).toBe(true);
  const after = await jsAndWasmMB(a);
  record({
    metric: `evict → JS+wasm memory freed (${TEXT_BYTES >> 20} MB doc)`,
    mode,
    value: before - after,
    unit: "MB",
  });
  expect.soft(before - after).toBeGreaterThan(0);

  const refound = await a.evaluate(
    async ([url, bytes, heads]) => {
      const { handle } = await window.bench.find(url);
      return {
        sameText:
          (handle.doc().text as string | undefined)?.length === bytes,
        sameHeads:
          JSON.stringify([...handle.heads()].sort()) === JSON.stringify(heads),
      };
    },
    [url, TEXT_BYTES, heads] as const
  );
  record({
    metric: "evict → re-find has the same text and heads",
    mode,
    value: refound.sameText && refound.sameHeads,
    unit: "ok",
  });
  expect.soft(refound.sameText && refound.sameHeads).toBe(true);

  const seen = awaitField(a, url, "counter", 1, EDIT_TIMEOUT_MS).then(
    () => true,
    () => false
  );
  await setField(b, url, "counter", 1);
  const siblingEditSeen = await seen;
  record({
    metric: "evict → re-find sees a sibling's edit",
    mode,
    value: siblingEditSeen,
    unit: "ok",
  });
  expect.soft(siblingEditSeen).toBe(true);

  const reachedSibling = awaitField(
    b,
    url,
    "marker",
    "unflushed",
    EDIT_TIMEOUT_MS
  ).then(
    () => true,
    () => false
  );
  await a.evaluate(
    async ([url, documentId]) => {
      const { handle } = await window.bench.find(url);
      handle.change((d) => {
        d.marker = "unflushed";
      });
      await window.repo.removeFromCache(documentId);
    },
    [url, documentId] as const
  );
  const survived = await reachedSibling;
  record({
    metric: "evict with an unflushed edit → a sibling sees it",
    mode,
    value: survived,
    unit: "ok",
  });
  expect.soft(survived).toBe(true);
});
