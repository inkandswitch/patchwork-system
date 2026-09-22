import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  createDoc,
  median,
  online,
  openTab,
  rendererMemory,
  rendererProcesses,
  timeFind,
  type Mode,
} from "./bench.js";

const ROWS = "bench-results/memory.jsonl";
const OUT = "bench-results/memory.md";
const SETTLE_MS = 3_000;
const GC_MS = 500;
const TABS = [1, 10];
const TYPE_ORDER = ["JavaScript", "WebAssembly", "DOM", "Shared", "Canvas", "other"];
const SCOPE_ORDER = [
  "Window",
  "DedicatedWorkerGlobalScope",
  "SharedWorkerGlobalScope",
  "ServiceWorkerGlobalScope",
  "none",
];

type Scenario = { name: string; url?: string; ready?: "marks" | "repo"; mode?: Mode };
const SCENARIOS: Scenario[] = [
  { name: "S0 about:blank" },
  {
    name: "S1 bundle parsed, no wasm",
    url: "/?mode=pertab-mesh&server=none&stop=js",
    ready: "marks",
  },
  {
    name: "S2 wasm instantiated, no Repo",
    url: "/?mode=pertab-mesh&server=none&stop=wasm",
    ready: "marks",
  },
  {
    name: "S3 Repo + IndexedDB + mesh, no socket, no doc",
    url: "/?mode=pertab-mesh&server=none",
    ready: "repo",
  },
  { name: "S4 pertab-mesh, server, shared doc", mode: "pertab-mesh" },
  { name: "S5 patchwork, server, shared doc", mode: "patchwork" },
];

type Muasm = {
  bytes: number;
  breakdown: Array<{
    bytes: number;
    types: string[];
    attribution: Array<{ url?: string; scope?: string }>;
  }>;
};
type Grouped = { bytes: number; types: Record<string, number>; scopes: Record<string, number> };
type Row = {
  scenario: string;
  n: number;
  footprintMb?: number;
  processes?: Array<{ pid: number; mb: number }>;
  heap?: Record<string, number>;
  muasm?: Grouped;
  wasmBoot?: [number, number];
  error?: string;
};

async function open(context: BrowserContext, scenario: Scenario, n: number): Promise<Page[]> {
  const pages: Page[] = [];
  if (scenario.mode) {
    for (let i = 0; i < n; i++) pages.push(await openTab(context, scenario.mode));
    await Promise.all(pages.map((page) => online(page)));
    const url = await createDoc(pages[0], { counter: 0 });
    await Promise.all(pages.slice(1).map((page) => timeFind(page, url)));
    return pages;
  }
  for (let i = 0; i < n; i++) {
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`[${scenario.name}]`, error.message));
    await page.goto(scenario.url ?? "about:blank");
    if (scenario.ready === "marks") {
      await page.waitForFunction(() => window.bench?.marks.ready !== undefined, null, {
        timeout: 60_000,
      });
    }
    if (scenario.ready === "repo") {
      await page.waitForFunction(() => window.repo != null, null, { timeout: 60_000 });
    }
    pages.push(page);
  }
  return pages;
}

function group(muasm: Muasm): Grouped {
  const types: Record<string, number> = {};
  const scopes: Record<string, number> = {};
  for (const { bytes, types: t, attribution } of muasm.breakdown) {
    for (const type of t.length ? t : ["other"]) types[type] = (types[type] ?? 0) + bytes;
    const owners = attribution.length ? attribution : [{ scope: "none" }];
    for (const { scope = "none" } of owners) {
      scopes[scope] = (scopes[scope] ?? 0) + bytes / owners.length;
    }
  }
  return { bytes: muasm.bytes, types, scopes };
}

function medians(records: Record<string, number>[]): Record<string, number> {
  const keys = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return Object.fromEntries(keys.map((k) => [k, median(records.map((r) => r[k] ?? 0))]));
}

async function measure(browser: Browser, pages: Page[]): Promise<Partial<Row>> {
  await pages[0].waitForTimeout(SETTLE_MS);
  const sessions = await Promise.all(
    pages.map((page) => page.context().newCDPSession(page))
  );
  await Promise.all(sessions.map((s) => s.send("HeapProfiler.collectGarbage")));
  await pages[0].waitForTimeout(GC_MS);
  const heaps = await Promise.all(
    sessions.map(async (s) => {
      await s.send("Performance.enable");
      const { metrics } = await s.send("Performance.getMetrics");
      return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    })
  );
  const [footprint, processes] = await Promise.all([
    rendererMemory(browser),
    rendererProcesses(browser),
  ]);
  const isolated = await pages[0].evaluate(() => crossOriginIsolated);
  const grouped = isolated
    ? await Promise.all(
        pages.map((page) =>
          page
            .evaluate(() =>
              (
                performance as unknown as {
                  measureUserAgentSpecificMemory(): Promise<Muasm>;
                }
              ).measureUserAgentSpecificMemory()
            )
            .then(group)
        )
      )
    : [];
  return {
    footprintMb: footprint.mb,
    processes,
    heap: medians(heaps),
    muasm: grouped.length
      ? {
          bytes: median(grouped.map((g) => g.bytes)),
          types: medians(grouped.map((g) => g.types)),
          scopes: medians(grouped.map((g) => g.scopes)),
        }
      : undefined,
  };
}

async function reloadTiming(page: Page): Promise<[number, number]> {
  const first = await page.evaluate(() => window.bench.marks.wasm);
  await page.reload();
  await page.waitForFunction(() => window.bench?.marks.ready !== undefined, null, {
    timeout: 60_000,
  });
  const second = await page.evaluate(() => window.bench.marks.wasm);
  return [Math.round(first), Math.round(second)];
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
const cell = (v: unknown) => (v === undefined || v === null ? "–" : String(v));

function scenarioTable(name: string, rows: Row[]): string {
  const cols = rows.map((row) => `N=${row.n}`);
  const line = (label: string, pick: (row: Row) => unknown) =>
    `| ${label} | ${rows.map((row) => cell(pick(row))).join(" | ")} |`;
  const per = (row: Row) => row.processes!.map((p) => p.mb);
  const keys = (pick: (row: Row) => Record<string, number> | undefined, order: string[]) => {
    const all = new Set(rows.flatMap((row) => Object.keys(pick(row) ?? {})));
    return [...order.filter((k) => all.has(k)), ...[...all].filter((k) => !order.includes(k))];
  };
  const out = [
    `### ${name}`,
    "",
    `| metric | ${cols.join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
    line("renderer footprint MB, all processes", (r) => r.footprintMb),
    line("renderer processes", (r) => r.processes?.length),
    line("helper processes (processes − tabs)", (r) => r.processes && r.processes.length - r.n),
    line(
      "per-process MB min / median / max",
      (r) =>
        r.processes &&
        `${Math.min(...per(r))} / ${median(per(r)).toFixed(1)} / ${Math.max(...per(r))}`
    ),
    line("JSHeapUsedSize MB (median tab)", (r) => r.heap && mb(r.heap.JSHeapUsedSize)),
    line("JSHeapTotalSize MB (median tab)", (r) => r.heap && mb(r.heap.JSHeapTotalSize)),
    line("Nodes (median tab)", (r) => r.heap?.Nodes),
    line("Documents (median tab)", (r) => r.heap?.Documents),
    line("MUASM total MB (median tab)", (r) => r.muasm && mb(r.muasm.bytes)),
    ...keys((r) => r.muasm?.types, TYPE_ORDER).map((k) =>
      line(`MUASM type ${k} MB`, (r) => r.muasm && mb(r.muasm.types[k] ?? 0))
    ),
    ...keys((r) => r.muasm?.scopes, SCOPE_ORDER).map((k) =>
      line(`MUASM scope ${k} MB`, (r) => r.muasm && mb(r.muasm.scopes[k] ?? 0))
    ),
  ];
  if (rows.some((r) => r.wasmBoot)) {
    out.push(line("nav→wasm ms, first load / reload", (r) => r.wasmBoot?.join(" / ")));
  }
  if (rows.some((r) => r.error)) out.push(line("error", (r) => r.error));
  return out.join("\n");
}

function summary(rows: Row[]): string {
  const header = [
    "scenario",
    "footprint MB N=1",
    "footprint MB N=10",
    "marginal MB/tab",
    "median process MB @N=10",
    "JS heap used MB",
    "MUASM JavaScript MB",
    "MUASM WebAssembly MB",
    "MUASM DOM MB",
    "medians at N",
  ];
  const lines = SCENARIOS.map(({ name }) => {
    const one = rows.find((r) => r.scenario === name && r.n === 1);
    const ten = rows.find((r) => r.scenario === name && r.n === 10);
    const at = ten?.heap ? ten : one?.heap ? one : undefined;
    const marginal =
      one?.footprintMb !== undefined && ten?.footprintMb !== undefined
        ? ((ten.footprintMb - one.footprintMb) / 9).toFixed(1)
        : undefined;
    return `| ${[
      name,
      one?.footprintMb,
      ten?.footprintMb,
      marginal,
      ten?.processes && median(ten.processes.map((p) => p.mb)).toFixed(1),
      at?.heap && mb(at.heap.JSHeapUsedSize),
      at?.muasm && mb(at.muasm.types.JavaScript ?? 0),
      at?.muasm && mb(at.muasm.types.WebAssembly ?? 0),
      at?.muasm && mb(at.muasm.types.DOM ?? 0),
      at?.n,
    ]
      .map(cell)
      .join(" | ")} |`;
  });
  return [
    "## Summary",
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...lines,
  ].join("\n");
}

function save(row: Row): Row[] {
  appendFileSync(ROWS, JSON.stringify(row) + "\n");
  const rows = [
    ...new Map(
      readFileSync(ROWS, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
        .map((r) => [`${r.scenario}:${r.n}`, r] as const)
    ).values(),
  ];
  const tables = SCENARIOS.map(({ name }) => rows.filter((r) => r.scenario === name))
    .filter((group) => group.length)
    .map((group) => scenarioTable(group[0].scenario, group));
  writeFileSync(OUT, ["# Renderer memory ladder", ...tables, summary(rows)].join("\n\n") + "\n");
  console.log("\n" + scenarioTable(row.scenario, rows.filter((r) => r.scenario === row.scenario)));
  return rows;
}

test.beforeAll(({}, info) => {
  if (info.workerIndex === 0) writeFileSync(ROWS, "");
});

test.afterAll(() => {
  console.log("\n" + readFileSync(OUT, "utf8").split("## Summary")[1]);
});

for (const scenario of SCENARIOS) {
  for (const n of TABS) {
    test(`${scenario.name}: ${n} tab(s)`, async ({ browser }) => {
      const context = await browser.newContext();
      const row: Row = { scenario: scenario.name, n };
      try {
        const pages = await open(context, scenario, n);
        Object.assign(row, await measure(browser, pages));
        if (scenario.name.startsWith("S2") && n === 1) {
          row.wasmBoot = await reloadTiming(pages[0]);
        }
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        await context.close();
        save(row);
      }
    });
  }
}
