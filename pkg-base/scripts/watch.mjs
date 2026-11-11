import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", "scripts", "static-dist", ".git"]);
const watchers = [];
const pending = new Set();
let bundleTimer;
let stopping = false;

function bundle() {
  const current = join(root, "static-dist");
  const names = [...pending];
  pending.clear();
  const args = ["scripts/bundle.mjs", "--strict"];
  for (const name of names) args.push("--filter", name);
  const result = spawnSync("node", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) return;
  writeFileSync(join(current, ".watch-ready"), `${Date.now()}\n`);
}

function schedule(name) {
  pending.add(name);
  clearTimeout(bundleTimer);
  bundleTimer = setTimeout(bundle, 500);
}

function watchOutput(name, path) {
  const watcher = watch(
    path,
    { recursive: statSync(path).isDirectory() },
    () => schedule(name),
  );
  watcher.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  watchers.push(watcher);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(bundleTimer);
  for (const watcher of watchers) watcher.close();
  tools.kill("SIGTERM");
  process.exitCode = code;
}

// On pnpm >= 11, `pnpm -r` at the (workspace-less) root recurses into every
// directory with a package.json — including the aggregated copies in
// static-dist/packages/, which keep their scripts but have no sources or
// node_modules. Exclude them or their failures kill the whole watch.
const notStaticDist = "--filter=!{static-dist/**}";

if (!existsSync(join(root, "static-dist", "modules.json"))) {
  for (const [command, args] of [
    ["pnpm", ["-r", "--if-present", notStaticDist, "build"]],
    ["node", ["scripts/bundle.mjs"]],
  ]) {
    const initial = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (initial.status !== 0) process.exit(initial.status ?? 1);
  }
}

for (const name of readdirSync(root)) {
  if (ignored.has(name) || name.startsWith(".")) continue;
  const directory = join(root, name);
  if (!statSync(directory).isDirectory()) continue;
  if (!existsSync(join(directory, "package.json"))) continue;
  const dist = join(directory, "dist");
  if (existsSync(dist)) watchOutput(name, dist);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (
      entry.name === "package.json" ||
      entry.name === "example.js" ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs")
    ) {
      watchOutput(name, join(directory, entry.name));
    }
  }
}

const tools = spawn(
  "pnpm",
  ["-r", "--parallel", "--if-present", notStaticDist, "dev"],
  { cwd: root, stdio: "inherit" },
);
tools.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});
tools.on("error", (error) => {
  console.error(error.message);
  stop(1);
});

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
