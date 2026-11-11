import { readFileSync, writeFileSync } from "node:fs";
import { MODES, RESULTS, type Result } from "./bench.js";

function cell({ value, unit }: Result): string {
  if (value === null || (typeof value === "number" && !Number.isFinite(value))) {
    return "–";
  }
  if (unit === "ok") return value ? "ok" : "FAIL";
  if (unit === "n") return String(value);
  return `${Math.round(Number(value))} ${unit}`;
}

function table(
  results: Result[],
  columns: string[],
  labels: string[],
  column: (result: Result) => string
): string {
  const rows = new Map<string, Partial<Record<string, string>>>();
  for (const result of results) {
    const { metric, tabs } = result;
    const key = tabs === undefined ? metric : `${metric} (${tabs} tabs)`;
    const row = rows.get(key) ?? {};
    row[column(result)] = cell(result);
    rows.set(key, row);
  }
  const header = ["metric", ...labels];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...[...rows].map(
      ([key, row]) =>
        `| ${key} | ${columns.map((c) => row[c] ?? "–").join(" | ")} |`
    ),
  ].join("\n");
}

// One row per metric. Also written to bench-results/results.md.
export default function globalTeardown(): void {
  const results: Result[] = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!results.length) return;

  const sections = [
    "## Patchwork\n\n" + table(results, MODES, MODES, (r) => r.mode),
  ];
  const out = sections.join("\n\n");
  writeFileSync("bench-results/results.md", out + "\n");
  console.log("\n" + out + "\n");
}
