import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Browser, BrowserContext, Page } from "@playwright/test";

export type Mode = "shared" | "pertab" | "pertab-bc";
export const MODES: Mode[] = ["shared", "pertab", "pertab-bc"];

export const RESULTS = "bench-results/results.jsonl";

export type Result = {
  metric: string;
  mode: Mode;
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

export async function openTab(
  context: BrowserContext,
  mode: Mode,
  { server }: { server?: string } = {}
): Promise<Page> {
  const page = await context.newPage();
  const query = new URLSearchParams({ mode });
  if (server !== undefined) query.set("server", server);
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
