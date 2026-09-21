import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export type Mode =
  | "patchwork"
  | "pertab"
  | "pertab-bc"
  | "tab-worker"
  | "shared-worker";
export const MODES: Mode[] = [
  "patchwork",
  "pertab",
  "pertab-bc",
  "tab-worker",
  "shared-worker",
];
export const WORKER_MODES: Mode[] = ["tab-worker", "shared-worker"];

export type Storage = "worker" | "direct";
export const STORAGES: Storage[] = ["worker", "direct"];

export const RESULTS = "bench-results/results.jsonl";

export type Result = {
  metric: string;
  mode: Mode;
  /** Set for the storage-adapter comparison, which is its own table. */
  storage?: Storage;
  tabs?: number;
  value: number | boolean;
  unit: "ms" | "MB" | "n" | "ok";
};

export function record(result: Result): void {
  appendFileSync(RESULTS, JSON.stringify(result) + "\n");
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The sync server's subduction peer id, learned once per run from a bare tab
// in a throwaway context (so nothing it fetches warms the test's own). A
// worker-hosted node can't tell the server from the tabs it accepts any other
// way; the tab modes can, but get it too so every mode measures the same peer.
let serverPeer: Promise<string> | undefined;
function probeServerPeer(browser: Browser): Promise<string> {
  return (serverPeer ??= (async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto("/?mode=pertab");
      await page.waitForFunction(() => window.repo != null, null, {
        timeout: 60_000,
      });
      await page.evaluate(() => window.bench.online());
      const [peer] = await page.evaluate(() => window.bench.serverPeerIds());
      if (!peer) throw new Error("couldn't learn the sync server's peer id");
      return peer;
    } finally {
      await context.close();
    }
  })());
}

export async function openTab(
  context: BrowserContext,
  mode: Mode,
  { server, storage }: { server?: string; storage?: Storage } = {}
): Promise<Page> {
  const query = new URLSearchParams({ mode });
  if (server !== undefined) query.set("server", server);
  if (storage !== undefined) query.set("storage", storage);
  if (server !== "none") {
    query.set("serverPeer", await probeServerPeer(context.browser()!));
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[${mode}]`, error.message));
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => window.repo != null, null, {
    timeout: 60_000,
  });
  return page;
}

export function marks(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => window.bench.marks);
}

export function online(page: Page): Promise<number> {
  return page.evaluate(() => window.bench.online());
}

export function isOnline(page: Page): Promise<boolean> {
  return page.evaluate(() => window.bench.isOnline());
}

/**
 * Cut the link to the sync server. Playwright's offline emulation reaches a
 * page's own socket but not a worker's (it skips worker sessions), so the
 * worker modes are also told to drop theirs and hold off reconnecting.
 */
export async function setOffline(
  context: BrowserContext,
  pages: Page[],
  offline: boolean
): Promise<void> {
  await context.setOffline(offline);
  await Promise.all(
    pages.map((page) =>
      page.evaluate((offline) => window.bench.setOffline(offline), offline)
    )
  );
}

/** Wait for `isOnline()` to report `expected`; false if it never does. */
export async function awaitOnline(
  page: Page,
  expected: boolean,
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isOnline(page)) === expected) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

export function createDoc(page: Page, value: object): Promise<string> {
  return page.evaluate((value) => {
    const handle = window.repo.create<Record<string, unknown>>();
    handle.change((d) => Object.assign(d, value));
    return handle.url;
  }, value);
}

/**
 * Time until `find()` has the doc in this tab, and how many tries it took:
 * more than one means a first find settled as unavailable.
 */
export function timeFind(
  page: Page,
  url: string
): Promise<{ ms: number; attempts: number }> {
  return page.evaluate(async (url) => {
    const started = performance.now();
    const { attempts } = await window.bench.find(url);
    return { ms: performance.now() - started, attempts };
  }, url);
}

// Cross-page timings use epoch ms: performance.now() counts from each page's
// own navigation start, so it can't be compared between tabs.

/** Set a field and return the time the change was made. */
export function setField(
  page: Page,
  url: string,
  field: string,
  value: unknown
): Promise<number> {
  return page.evaluate(
    async ([url, field, value]) => {
      const { handle } = await window.bench.find(url);
      handle.change((d) => {
        d[field] = value;
      });
      return performance.timeOrigin + performance.now();
    },
    [url, field, value] as const
  );
}

/** Resolves with the time this tab saw `field === value`. */
export function awaitField(
  page: Page,
  url: string,
  field: string,
  value: unknown,
  timeoutMs = 30_000
): Promise<number> {
  return page.evaluate(
    ([url, field, value, timeoutMs]) =>
      new Promise<number>(async (resolve, reject) => {
        const { handle } = await window.bench.find(url).catch((error) => {
          reject(error);
          throw error;
        });
        const check = () => {
          if (handle.doc()?.[field] !== value) return false;
          handle.off("change", check);
          resolve(performance.timeOrigin + performance.now());
          return true;
        };
        if (check()) return;
        handle.on("change", check);
        setTimeout(() => {
          handle.off("change", check);
          reject(new Error(`${field} never became ${value}`));
        }, timeoutMs);
      }),
    [url, field, value, timeoutMs] as const
  );
}

export function serverConfirmed(page: Page, url: string): Promise<number> {
  return page.evaluate((url) => window.bench.serverConfirmed(url), url);
}

export function getField<T>(page: Page, url: string, field: string): Promise<T> {
  return page.evaluate(
    async ([url, field]) => {
      const { handle } = await window.bench.find(url);
      return handle.doc()[field] as T;
    },
    [url, field] as const
  );
}

export function flush(page: Page): Promise<void> {
  return page.evaluate(() => window.repo.flush());
}

export type Stall = {
  maxMs: number;
  totalMs: number;
  longTasks: number;
  longTaskMs: number;
};

/** Run `work` with the page's main-thread stall probe around it. */
export async function withStall<T>(
  page: Page,
  work: () => Promise<T>
): Promise<{ result: T; stall: Stall }> {
  await page.evaluate(() => window.bench.stallStart());
  const result = await work();
  const stall = await page.evaluate(() => window.bench.stallStop());
  return { result, stall };
}

/**
 * Memory of every renderer process in the browser, in MB — tabs, their
 * dedicated workers, and the shared workers, wherever Chrome placed them.
 * Nothing in a page can see across processes (measureUserAgentSpecificMemory
 * only covers the caller's own agent cluster), so the pids come from CDP and
 * the sizes from the OS: physical footprint on macOS, the same number Activity
 * Monitor shows, and plain RSS elsewhere, which overcounts shared mappings
 * per process and so flatters whichever topology has fewer processes.
 */
export async function rendererMemory(
  browser: Browser
): Promise<{ mb: number; processes: number }> {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: Array<{ type: string; id: number }>;
  };
  await session.detach();
  const pids = processInfo
    .filter((process) => process.type === "renderer")
    .map((process) => String(process.id));
  if (!pids.length) return { mb: 0, processes: 0 };

  if (process.platform === "darwin") {
    const out = execFileSync("footprint", pids.flatMap((pid) => ["-p", pid]), {
      encoding: "utf8",
    });
    let mb = 0;
    for (const [, size, unit] of out.matchAll(
      /phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/g
    )) {
      mb += Number(size) * { KB: 1 / 1024, MB: 1, GB: 1024 }[unit]!;
    }
    return { mb: Math.round(mb), processes: pids.length };
  }

  const rss = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const kb = rss
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.trim()), 0);
  return { mb: Math.round(kb / 1024), processes: pids.length };
}
