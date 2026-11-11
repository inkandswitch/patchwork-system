#!/usr/bin/env node
/**
 * Orchestrate the static tools bundle for patchwork-base.
 *
 * This is the install/build front-end that the root `package.json` scripts
 * (`build:static`, `build:static:fresh`, `build:tools:ci`) point at; the actual
 * aggregation lives in scripts/bundle.mjs.
 *
 * patchwork-base is NOT a workspace — every top-level folder is a package that
 * installs and builds on its own, into its own node_modules. So both the
 * install and the build run per-tool, in any order: no tool may depend on
 * another one having been installed or built first (scripts/lint-standalone.mjs
 * enforces that). One tool failing doesn't abort the bundle; bundle.mjs simply
 * skips any tool without a built entry point.
 *
 * Tools install and build concurrently (up to `BUILD_CONCURRENCY`, default =
 * CPUs - 1). Each tool's output is buffered and flushed as a block when it
 * finishes so the interleaved logs stay readable.
 *
 * Usage:
 *   node scripts/build-static.mjs                 # bundle already-built tools
 *   node scripts/build-static.mjs --build         # build each tool, then bundle
 *   node scripts/build-static.mjs --install       # install + build each tool, then bundle
 *   node scripts/build-static.mjs --filter <name> # restrict to tools whose dir name includes <name> (repeatable)
 *   node scripts/build-static.mjs --strict         # exit non-zero if any tool fails
 *   node scripts/build-static.mjs --out <dir>      # output dir (default: static-dist)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Pin npx's pnpm to the exact version the workspace pins in package.json
// "packageManager" (sans integrity hash). A floating spec like `pnpm@11` can
// resolve to a newer release than the pin, and pnpm 11.13+ hard-errors when
// the running version disagrees with "packageManager" under corepack.
const PNPM = (() => {
  const pm = readPkg(ROOT)?.packageManager;
  const match = typeof pm === "string" ? pm.match(/^pnpm@([^+]+)/) : null;
  return match ? `pnpm@${match[1]}` : "pnpm@11";
})();

// Mirror bundle.mjs: directories that are never tools.
const IGNORE_DIRS = new Set([
  "node_modules",
  "scripts",
  "static-dist",
  "dist",
  ".git",
  ".pushwork",
]);

function parseArgs(argv) {
  const args = { out: "static-dist", install: false, build: false, strict: false, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--install") args.install = true;
    else if (a === "--build") args.build = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--filter") args.filters.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  // --install implies --build (no point installing without building).
  if (args.install) args.build = true;
  return args;
}

function listToolDirs(filters) {
  return readdirSync(ROOT)
    .sort()
    .filter((name) => {
      if (IGNORE_DIRS.has(name) || name.startsWith(".")) return false;
      const dir = join(ROOT, name);
      if (!statSync(dir).isDirectory()) return false;
      if (!existsSync(join(dir, "package.json"))) return false;
      if (filters.length && !filters.some((f) => name.includes(f))) return false;
      return true;
    });
}

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  return res.status === 0;
}

// Async variant used for the parallel build loop. Buffers stdout+stderr so a
// tool's log can be flushed as one contiguous block once it completes.
function runBuffered(cmd, args, cwd) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(cmd, args, { cwd, shell: false });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => resolve({ ok: false, output: `${err}\n` }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8") })
    );
  });
}

/**
 * Run `pnpm <script>` in each named tool, up to `concurrency` at a time and in
 * no particular order. Returns { succeeded, failures }.
 */
async function runEach(script, names, concurrency) {
  const queue = [...names];
  const succeeded = [];
  const failures = [];

  async function worker() {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const { ok, output } = await runBuffered(
        "npx",
        [PNPM, script],
        join(ROOT, name)
      );
      process.stdout.write(`\n── ${script} ${name} ──\n${output}`);
      if (ok) succeeded.push(name);
      else {
        console.error(`[fail]  ${name}: pnpm ${script}`);
        failures.push(`${name} (${script})`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { succeeded, failures };
}

async function main() {
  const { out, install, build, strict, filters } = parseArgs(process.argv.slice(2));
  const tools = listToolDirs(filters);
  const concurrency = Math.max(
    1,
    Number(process.env.BUILD_CONCURRENCY) || availableParallelism() - 1
  );

  const failures = [];
  let built = [];
  // bundleless tools (single .js at root)
  const noBuild = tools.filter((n) => !readPkg(join(ROOT, n))?.scripts?.build);

  if (install) {
    console.log(`\nInstalling ${tools.length} tool(s) (concurrency: ${concurrency})\n`);
    failures.push(...(await runEach("install", tools, concurrency)).failures);
  }

  if (build) {
    const buildable = tools.filter((n) => !noBuild.includes(n));
    console.log(
      `\nBuilding ${buildable.length} tool(s) (concurrency: ${concurrency})` +
        (filters.length ? ` (filter: ${filters.join(", ")})` : "") +
        "\n"
    );

    const result = await runEach("build", buildable, concurrency);
    built = result.succeeded;
    failures.push(...result.failures);
  }

  // Aggregate whatever built into static-dist/.
  console.log(`\n── aggregating into ${out} ──`);
  const bundleOk = run("node", [join(ROOT, "scripts", "bundle.mjs"), "--out", out], ROOT);

  // Summary.
  if (build) {
    console.log(
      `\nBuilt ${built.length}, bundleless/no-build ${noBuild.length}, failed ${failures.length}.`
    );
    if (failures.length) {
      console.log("Failed tools:");
      for (const f of failures) console.log(`  - ${f}`);
    }
  }

  if (!bundleOk) process.exit(1);
  if (strict && failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
