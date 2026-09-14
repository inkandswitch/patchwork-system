import { readFileSync, writeFileSync } from "node:fs";
import { MODES, RESULTS, type Result } from "./bench.js";

// One row per metric, one column per mode, so the three topologies read side
// by side. Also written to bench-results/results.md.
export default function globalTeardown(): void {
  const results: Result[] = readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!results.length) return;

  const rows = new Map<string, Partial<Record<string, string>>>();
  for (const { metric, mode, tabs, value, unit } of results) {
    const key = tabs === undefined ? metric : `${metric} (${tabs} tabs)`;
    const row = rows.get(key) ?? {};
    row[mode] =
      unit === "ok"
        ? value
          ? "ok"
          : "FAIL"
        : unit === "n"
          ? String(value)
          : `${Math.round(Number(value))} ${unit}`;
    rows.set(key, row);
  }

  const header = ["metric", ...MODES];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...[...rows].map(
      ([key, row]) =>
        `| ${key} | ${MODES.map((mode) => row[mode] ?? "–").join(" | ")} |`
    ),
  ];
  const table = lines.join("\n");
  writeFileSync("bench-results/results.md", table + "\n");
  console.log("\n" + table + "\n");
}
