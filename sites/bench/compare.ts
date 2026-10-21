// Puts two bench runs side by side, main's and a PR's, as markdown:
//
//   node compare.ts <main's bench-results> <the PR's bench-results>
//
// Each side ran its own checkout's benchmarks, so a benchmark the PR adds or
// renames shows – for main. Every number is lower-is-better.
import { readFileSync } from "node:fs";

// A single run on a GitHub runner moves by about this much on its own.
const NOISE = 0.2;
// ...and by this much in absolute terms, for small values.
const FLOOR: Record<string, number> = { ms: 10, MB: 2 };

type Unit = "ms" | "MB" | "n" | "ok";
type Result = {
  metric: string;
  mode: string;
  storage?: string;
  tabs?: number;
  value: number | boolean | null;
  unit: Unit;
};
type MemoryRow = { scenario: string; n: number; footprintMb?: number };

type Row = { section: string; name: string; where: string; unit: Unit };
type Side = Map<string, number | boolean | null>;

const STORAGE_LABELS: Record<string, string> = {
  worker: "idb worker",
  direct: "idb in-thread",
  opfs: "opfs in-thread",
  sqlite: "sqlite worker",
  redb: "redb worker",
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

function read(dir: string): Side {
  const side: Side = new Map();
  const add = (row: Row, value: number | boolean | null) => {
    const key = [row.section, row.name, row.where].join("\0");
    if (!rows.has(key)) rows.set(key, row);
    side.set(key, value);
  };
  for (const r of lines<Result>(`${dir}/results.jsonl`)) {
    const name =
      r.tabs === undefined ? r.metric : `${r.metric} (${r.tabs} tabs)`;
    if (r.storage === undefined) {
      add({ section: "Topology", name, where: r.mode, unit: r.unit }, r.value);
    } else {
      const where = STORAGE_LABELS[r.storage] ?? r.storage;
      add({ section: "Storage adapter", name, where, unit: r.unit }, r.value);
    }
  }
  for (const r of lines<MemoryRow>(`${dir}/memory.jsonl`)) {
    const row = {
      section: "Renderer memory",
      name: "renderer footprint, all processes",
      where: `${r.scenario}, ${r.n} tab${r.n === 1 ? "" : "s"}`,
      unit: "MB" as const,
    };
    add(row, r.footprintMb ?? null);
  }
  return side;
}

function measured(
  value: number | boolean | null | undefined
): value is number | boolean {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "boolean" || Number.isFinite(value))
  );
}

function cell(value: number | boolean | null | undefined, unit: Unit): string {
  if (!measured(value)) return "–";
  if (unit === "ok") return value ? "ok" : "FAIL";
  if (unit === "n") return String(value);
  if (unit === "MB" && Number(value) < 10)
    return `${Number(value).toFixed(2)} MB`;
  return `${Math.round(Number(value))} ${unit}`;
}

/** The change from main to the PR, and whether it's more than noise. */
function change(
  before: number | boolean | null | undefined,
  after: number | boolean | null | undefined,
  unit: Unit
): { text: string; moved: boolean } {
  if (!measured(before) || !measured(after)) return { text: "", moved: false };
  if (unit === "ok") {
    if (before === after) return { text: "", moved: false };
    return { text: after ? "**fixed**" : "**broken**", moved: true };
  }
  const a = Number(before);
  const b = Number(after);
  if (a === b) return { text: "", moved: false };
  const by = a === 0 ? Infinity : (b - a) / a;
  const moved =
    unit === "n" ||
    (Math.abs(by) >= NOISE && Math.abs(b - a) >= (FLOOR[unit] ?? 0));
  const percent = Number.isFinite(by)
    ? `${by > 0 ? "+" : "−"}${Math.abs(Math.round(by * 100))}%`
    : `+${cell(b - a, unit)}`;
  if (!moved) return { text: percent, moved };
  return { text: `**${percent} ${b > a ? "worse" : "better"}**`, moved };
}

function table(keys: string[], main: Side, pr: Side): string {
  return [
    "| benchmark | | main | PR | change |",
    "| --- | --- | --- | --- | --- |",
    ...keys.map((key) => {
      const { name, where, unit } = rows.get(key)!;
      const { text } = change(main.get(key), pr.get(key), unit);
      return `| ${name} | ${where} | ${cell(main.get(key), unit)} | ${cell(pr.get(key), unit)} | ${text} |`;
    }),
  ].join("\n");
}

const [mainDir, prDir] = process.argv.slice(2);
if (!mainDir || !prDir) {
  console.error(
    "usage: node compare.ts <main's bench-results> <the PR's bench-results>"
  );
  process.exit(2);
}
const main = read(mainDir);
const pr = read(prDir);
const keys = [...rows.keys()];
const moved = keys.filter(
  (key) => change(main.get(key), pr.get(key), rows.get(key)!.unit).moved
);

const out: string[] = [];
if (!pr.size) out.push("The PR's benchmarks recorded nothing.");
else if (!main.size)
  out.push(
    "main's benchmarks recorded nothing, so there's nothing to compare against."
  );
else if (moved.length) out.push(table(moved, main, pr));
else out.push(`Nothing moved by more than ${NOISE * 100}%.`);

const sections = [...new Set(keys.map((key) => rows.get(key)!.section))];
out.push(
  "",
  `<details><summary>every benchmark</summary>`,
  "",
  ...sections.flatMap((section) => [
    `#### ${section}`,
    "",
    table(
      keys.filter((key) => rows.get(key)!.section === section),
      main,
      pr
    ),
    "",
  ]),
  "</details>"
);
console.log(out.join("\n"));
