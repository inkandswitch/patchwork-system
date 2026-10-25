// Puts bench runs of main and a PR side by side, as markdown:
//
//   node compare.ts --main <bench-results>... --pr <bench-results>... [--why <file>]
//
// Exits 1 when the PR fails a check main passes, and with --why writes a line
// per such check saying why, for the workflow's error annotations.
//
// Each directory is one run. Only Patchwork as it ships, `patchwork` mode: the
// other modes and the storage adapters are alternatives the bench explores,
// not what merging the PR changes. Each side ran its own checkout's
// benchmarks, so a benchmark (or browser) the PR adds or renames shows – for
// main. A result without a browser is chromium's, from before there were
// others. Every number is lower-is-better.
import { readFileSync, writeFileSync } from "node:fs";

// A row has changed when the two sides' runs don't overlap at all, every run of
// the PR above every run of main or below it, so one slow run can't do it
// alone. And by enough to matter: the medians apart by this much of main's...
const SIGNIFICANT = 0.2;
// ...and at least this much in absolute terms, for small values.
const FLOOR: Record<string, number> = { ms: 10, MB: 2 };

type Unit = "ms" | "MB" | "n" | "ok";
type Value = number | boolean;
type Result = {
  metric: string;
  mode: string;
  storage?: string;
  tabs?: number;
  value: number | boolean | null;
  unit: Unit;
  browser?: string;
  /** A check on the bench, not Patchwork (see bench.ts): never fails a PR. */
  harness?: true;
  /** What the test saw, for a check that failed. */
  note?: string;
};
type MemoryRow = { scenario: string; n: number; footprintMb?: number };

const BROWSERS = ["chromium", "firefox", "webkit"];

type Row = { name: string; unit: Unit; browser: string; harness?: true };
/**
 * A side's measurements of each row, a value per run that measured it, and
 * alongside each value the note its run left, if any.
 */
type Side = {
  runs: number;
  values: Map<string, Value[]>;
  notes: Map<string, (string | undefined)[]>;
};

function lines<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

const rows = new Map<string, Row>();

function measured(value: unknown): value is Value {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function read(dirs: string[]): Side {
  const side: Side = { runs: 0, values: new Map(), notes: new Map() };
  for (const dir of dirs) {
    const run = new Map<string, { value: Value; note?: string }>();
    const add = (row: Row, value: unknown, note?: string) => {
      const key = `${row.browser}: ${row.name}`;
      if (!rows.has(key)) rows.set(key, row);
      // main's checkout may predate the flag.
      if (row.harness) rows.get(key)!.harness = true;
      if (measured(value)) run.set(key, { value, note });
    };
    for (const r of lines<Result>(`${dir}/results.jsonl`)) {
      if (r.mode !== "patchwork" || r.storage !== undefined) continue;
      const name =
        r.tabs === undefined ? r.metric : `${r.metric} (${r.tabs} tabs)`;
      add(
        { name, unit: r.unit, browser: r.browser ?? "chromium", harness: r.harness },
        r.value,
        r.note
      );
    }
    // The memory ladder is chromium only.
    for (const r of lines<MemoryRow>(`${dir}/memory.jsonl`)) {
      if (!/\bpatchwork\b/.test(r.scenario)) continue;
      const name = `renderer memory, ${r.n} tab${r.n === 1 ? "" : "s"}`;
      add({ name, unit: "MB", browser: "chromium" }, r.footprintMb);
    }
    for (const [key, { value, note }] of run) {
      side.values.set(key, [...(side.values.get(key) ?? []), value]);
      side.notes.set(key, [...(side.notes.get(key) ?? []), note]);
    }
  }
  // Each browser's runs are their own directories, so a side ran as many
  // times as its most-measured row.
  side.runs = Math.max(0, ...[...side.values.values()].map((v) => v.length));
  return side;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function amount(value: number, unit: Unit): string {
  if (unit === "n") return String(value);
  if (unit === "MB" && value < 10) return `${value.toFixed(2)} MB`;
  return `${Math.round(value)} ${unit}`;
}

/** A side's runs of a row: the median, then the range when they differ. */
function cell(values: Value[] | undefined, unit: Unit): string {
  if (!values?.length) return "–";
  if (unit === "ok") {
    const ok = values.filter(Boolean).length;
    if (ok === values.length) return "ok";
    if (ok === 0) return "FAIL";
    return `${ok}/${values.length} ok`;
  }
  const numbers = values.map(Number);
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const middle = amount(median(numbers), unit);
  if (low === high) return middle;
  const bare = (value: number) => amount(value, unit).replace(` ${unit}`, "");
  return `${middle} (${bare(low)}–${bare(high)})`;
}

/**
 * The change from main to the PR, whether it's more than noise, and whether
 * it fails the PR: a check main passes, or doesn't have yet, failing in any run
 * of the PR. A check main fails too doesn't.
 */
function change(
  before: Value[] | undefined,
  after: Value[] | undefined,
  unit: Unit
): { text: string; moved: boolean; breaks?: boolean } {
  if (unit === "ok" && after?.length) {
    const mainOk = !before?.length || before.every(Boolean);
    const failed = after.filter((v) => !v).length;
    if (mainOk && failed) {
      return {
        text: `**fails ${failed} of ${after.length}**`,
        moved: true,
        breaks: true,
      };
    }
    if (!mainOk && !failed) return { text: "**fixed**", moved: true };
    return { text: "", moved: false };
  }
  if (!before?.length || !after?.length) return { text: "", moved: false };
  const a = before.map(Number);
  const b = after.map(Number);
  const ma = median(a);
  const mb = median(b);
  if (ma === mb) return { text: "", moved: false };
  const apart =
    Math.max(...b) < Math.min(...a) || Math.min(...b) > Math.max(...a);
  const by = ma === 0 ? Infinity : (mb - ma) / ma;
  const moved =
    apart &&
    (unit === "n" ||
      (Math.abs(by) >= SIGNIFICANT && Math.abs(mb - ma) >= (FLOOR[unit] ?? 0)));
  const percent = Number.isFinite(by)
    ? `${by > 0 ? "+" : "−"}${Math.abs(Math.round(by * 100))}%`
    : `+${amount(mb - ma, unit)}`;
  if (!moved) return { text: percent, moved };
  return { text: `**${percent} ${mb > ma ? "worse" : "better"}**`, moved };
}

/** With more than one browser, each row says which. */
function table(keys: string[], main: Side, pr: Side): string {
  const browsers = new Set([...rows.values()].map((row) => row.browser));
  const many = browsers.size > 1;
  return [
    `| ${many ? "browser | " : ""}benchmark | main | PR | change |`,
    `| ${many ? "--- | " : ""}--- | --- | --- | --- |`,
    ...keys.map((key) => {
      const { name, unit, browser, harness } = rows.get(key)!;
      const before = main.values.get(key);
      const after = pr.values.get(key);
      let { text, breaks } = change(before, after, unit);
      if (harness && breaks) {
        text = `${text.replaceAll("**", "")} (the bench, not the PR)`;
      }
      return `| ${many ? `${browser} | ` : ""}${name} | ${cell(before, unit)} | ${cell(after, unit)} | ${text} |`;
    }),
  ].join("\n");
}

function runs(n: number): string {
  return n === 1 ? "1 run" : `${n} runs`;
}

/**
 * Why a check fails the PR, following its name: the runs it failed in, why main's side of it
 * doesn't excuse that, and what the test saw in each of those runs.
 */
function why(key: string): string {
  const { browser } = rows.get(key)!;
  const before = main.values.get(key);
  const after = pr.values.get(key)!;
  const notes = pr.notes.get(key)!;
  const failed = after.flatMap((value, i) => (value ? [] : [i]));
  const which =
    failed.length === after.length
      ? `every run of the PR (${after.length})`
      : `run ${failed.map((i) => i + 1).join(" and ")} of the PR's ${after.length}`;
  const mainHasBrowser = [...main.values.keys()].some((k) =>
    k.startsWith(`${browser}: `)
  );
  const baseline = before?.length
    ? `main passed it in all ${runs(before.length)}`
    : mainHasBrowser
      ? "main doesn't have this check, so a failure counts"
      : `main has no ${browser} results to compare with, so a failure counts`;
  const saw = failed
    .filter((i) => notes[i])
    .map((i) => ` Run ${i + 1}: ${notes[i]}`)
    .join("");
  return `failed in ${which}; ${baseline}.${saw}`;
}

function dirsAfter(flag: string): string[] {
  const args = process.argv.slice(2);
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const end = args.findIndex((arg, i) => i > at && arg.startsWith("--"));
  return args.slice(at + 1, end < 0 ? undefined : end);
}

const mainDirs = dirsAfter("--main");
const prDirs = dirsAfter("--pr");
if (!mainDirs.length || !prDirs.length) {
  console.error(
    "usage: node compare.ts --main <bench-results>... --pr <bench-results>..."
  );
  process.exit(2);
}
const main = read(mainDirs);
const pr = read(prDirs);
// Grouped by browser, each in the order its rows were first recorded.
const rank = (browser: string) =>
  BROWSERS.includes(browser) ? BROWSERS.indexOf(browser) : BROWSERS.length;
const keys = [...rows.keys()].sort(
  (a, b) => rank(rows.get(a)!.browser) - rank(rows.get(b)!.browser)
);
const changes = new Map(
  keys.map((key) => [
    key,
    change(main.values.get(key), pr.values.get(key), rows.get(key)!.unit),
  ])
);
const moved = keys.filter((key) => changes.get(key)!.moved);
const broken = keys.filter(
  (key) => changes.get(key)!.breaks && !rows.get(key)!.harness
);

const out: string[] = [];
if (broken.length) {
  const reasons = broken.map((key) => [key, why(key)]);
  out.push(
    `**This run fails: the PR fails ${broken.length === 1 ? "a check" : `${broken.length} checks`} main passes.**`,
    "",
    ...reasons.map(([key, reason]) => `- **${key}** ${reason}`),
    ""
  );
  const args = process.argv.slice(2);
  const whyFile = args.includes("--why") ? args[args.indexOf("--why") + 1] : undefined;
  if (whyFile) writeFileSync(whyFile, reasons.map((r) => `${r.join(" ")}\n`).join(""));
  // The workflow fails on this, once the comment is posted.
  process.exitCode = 1;
}
if (!pr.runs) out.push("The PR's benchmarks recorded nothing.");
else if (!main.runs)
  out.push(
    "main's benchmarks recorded nothing, so there's nothing to compare against."
  );
else if (moved.length) out.push(table(moved, main, pr));
else out.push("Nothing changed by more than the runs vary.");

out.push(
  "",
  `<details><summary>every benchmark: the median of ${runs(main.runs)} of main and ${runs(pr.runs)} of the PR, their range in brackets</summary>`,
  "",
  table(keys, main, pr),
  "",
  "</details>"
);
console.log(out.join("\n"));
