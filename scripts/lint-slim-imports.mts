import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { slim } from "../core/bootloader/src/externals-list.ts";

const root = join(import.meta.dirname, "..");
const roots = ["core", "packages", "sites"];
const skip = new Set(["node_modules", "dist", "test", "tests"]);
const extensions = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

const names = Object.keys(slim)
  .map((name) => name.replace(/[/.]/g, "\\$&"))
  .join("|");
const bare = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)["'](${names})["']`,
  "g"
);

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (extensions.test(entry.name)) yield path;
  }
}

let failures = 0;
for (const dir of roots) {
  for (const file of files(join(root, dir))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(bare)) {
      const line = source.slice(0, match.index).split("\n").length;
      const name = match[1]!;
      console.error(
        `${relative(root, file)}:${line}: "${name}" instantiates its own wasm; import "${slim[name]}"`
      );
      failures++;
    }
  }
}

if (failures) process.exit(1);
