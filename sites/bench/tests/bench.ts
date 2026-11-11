import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export type Mode = "patchwork";
export const MODES: Mode[] = ["patchwork"];

export const RESULTS = "bench-results/results.jsonl";

export type Result = {
  metric: string;
  mode: Mode;
  tabs?: number;
  /** null: no measurement, printed as – */
  value: number | boolean | null;
  unit: "ms" | "MB" | "n" | "ok";
  /** The Playwright project it ran in: chromium, firefox or webkit. */
  browser?: string;
  /** What the test saw, for a check that failed: shown with the failure. */
  note?: string;
  /**
   * A check on the bench itself (did the offline switch hold?), not on
   * Patchwork: shown, but a PR can't fail it.
   */
  harness?: true;
};

export function record(result: Result): void {
  const browser = result.browser ?? test.info().project.name;
  appendFileSync(RESULTS, JSON.stringify({ ...result, browser }) + "\n");
}

/**
 * A thrown error's first line, without Playwright's prefix, and with hashes
 * cut short enough to read: for a failed check's note.
 */
export const said = (error: unknown): string =>
  String(error instanceof Error ? error.message : error)
    .split("\n")[0]
    .replace(/^.*?Error: /, "")
    .replace(/\b(\w{8})\w{24,}/g, "$1…");

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function openTab(
  context: BrowserContext,
  { open }: { open?: string } = {}
): Promise<Page> {
  const query = new URLSearchParams();
  if (open !== undefined) query.set("open", open);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("[patchwork]", error.message));
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

export type OfflineSwitch = {
  /** Cut or restore the link to the sync server in every tab. */
  set(pages: Page[], offline: boolean): Promise<void>;
};

/**
 * An offline switch. The one socket to the sync server is the automerge
 * worker's, which Playwright's \`setOffline\` and \`routeWebSocket\` can't reach,
 * so the worker is told to drop it and fail its reconnects while offline
 * (PortBackend.setOffline, via \`window.bench.setOffline\`).
 */
export function offlineSwitch(): OfflineSwitch {
  return {
    async set(pages, offline) {
      await Promise.all(
        pages.map((page) =>
          page.evaluate((offline) => window.bench.setOffline(offline), offline)
        )
      );
    },
  };
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
  return page.evaluate(async (value) => {
    const handle = await window.repo.create<Record<string, unknown>>();
    await handle.change((d) => {
      Object.assign(d, value);
    });
    return handle.url;
  }, value);
}

/**
 * Time until `find()` has the doc in this tab, and how many tries it took:
 * more than one means a first find settled as unavailable.
 */
export function timeFind(
  page: Page,
  url: string,
  timeoutMs = 30_000
): Promise<{ ms: number; attempts: number }> {
  return page.evaluate(
    async ([url, timeoutMs]) => {
      const started = performance.now();
      const { attempts } = await window.bench.find(url, timeoutMs);
      return { ms: performance.now() - started, attempts };
    },
    [url, timeoutMs] as const
  );
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
      // The change applies at once; the promise is only for persistence.
      void handle.change((d) => {
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

export function serverConfirmed(
  page: Page,
  url: string,
  timeoutMs = 30_000
): Promise<number> {
  return page.evaluate(
    ([url, timeoutMs]) => window.bench.serverConfirmed(url, timeoutMs),
    [url, timeoutMs] as const
  );
}

export function getField<T>(page: Page, url: string, field: string): Promise<T> {
  return page.evaluate(
    async ([url, field]) => {
      const { handle } = await window.bench.find(url);
      return handle.doc()![field] as T;
    },
    [url, field] as const
  );
}

/**
 * The doc as a client that shares nothing with these tabs sees it — a fresh
 * browser context, so a worker and storage of its own, only the server to ask. undefined if it
 * can't get the doc at all.
 */
export async function strangerSees(
  browser: Browser,
  url: string,
  timeoutMs = 10_000
): Promise<Record<string, unknown> | undefined> {
  const context = await browser.newContext();
  try {
    const page = await openTab(context);
    await online(page);
    return await page
      .evaluate(
        async ([url, timeoutMs]) => {
          const { handle } = await window.bench.find(url, timeoutMs);
          return JSON.parse(JSON.stringify(handle.doc())) as Record<
            string,
            unknown
          >;
        },
        [url, timeoutMs] as const
      )
      .catch(() => undefined);
  } finally {
    await context.close();
  }
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
 * per process and so flatters whichever topology has fewer processes. Null in
 * firefox and webkit, which have no CDP.
 */
export async function rendererMemory(
  browser: Browser
): Promise<{ mb: number | null; processes: number | null }> {
  if (browser.browserType().name() !== "chromium") {
    return { mb: null, processes: null };
  }
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

export async function rendererProcesses(
  browser: Browser
): Promise<Array<{ pid: number; mb: number }>> {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: Array<{ type: string; id: number }>;
  };
  await session.detach();
  const pids = processInfo
    .filter((process) => process.type === "renderer")
    .map((process) => process.id);
  return pids.map((pid) => {
    if (process.platform === "darwin") {
      const out = execFileSync(
        "footprint",
        ["-f", "bytes", "-p", String(pid)],
        { encoding: "utf8" }
      );
      const bytes = Number(out.match(/phys_footprint:\s+(\d+)/)?.[1] ?? 0);
      return { pid, mb: Math.round(bytes / 104857.6) / 10 };
    }
    const rss = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return { pid, mb: Math.round(Number(rss.trim()) / 102.4) / 10 };
  });
}
