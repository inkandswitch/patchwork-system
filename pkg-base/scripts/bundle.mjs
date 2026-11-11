#!/usr/bin/env node
/**
 * Aggregate every patchwork-base tool's built `dist/` into a single static,
 * HTTP-servable directory plus a `modules.json` manifest.
 *
 * The manifest has the same shape as a Patchwork module-settings document
 * (`{ "@patchwork": { type: "patchwork:module-settings" }, modules: [...] }`)
 * but lives as a plain JSON file. Each module entry is a relative URL to a
 * tool's *directory* (`./packages/<name>/`), which serves that tool's
 * `package.json`. At load time the runtime fetches the package.json and
 * resolves its entry point itself (`exports["."]` under the
 * `patchwork`/`browser`/`import` conditions, falling back to `main`) — the same
 * way it resolves an Automerge folder doc — so the tool's own package.json is
 * the single source of truth for its entry point.
 *
 * We still resolve the entry point here, but only to validate the build and to
 * know which files to copy.
 *
 * Tools may also ship an `example.js` next to their package.json: a plain ES
 * module whose default export creates example document(s) for a fresh account
 * and returns their DocLink(s). Those are copied alongside the tool and
 * aggregated into a generated `init.js` next to `modules.json`; a shell runs
 * that script once per fresh account to seed its Examples folder.
 *
 * This only aggregates; it does not install or build. Install/build the tools
 * first (from the repo root: `pnpm install` then `pnpm build`, which skip the
 * output folder), then run this to assemble `static-dist/`.
 *
 * Usage:
 *   node scripts/bundle.mjs [--out <dir>]
 *
 *   --out <dir>   Output directory (default: static-dist)
 */
import { existsSync, readFileSync, rmSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Conditions mirror `defaultImportConditions` in
// @inkandswitch/patchwork-filesystem so static resolution matches runtime.
const CONDITIONS = ["patchwork", "browser", "import"];

// Directories that are never tools.
const IGNORE_DIRS = new Set([
  "node_modules",
  "scripts",
  "static-dist",
  "static-dist.next",
  "static-dist.previous",
  "dist",
  ".git",
  ".pushwork",
]);

function parseArgs(argv) {
  const args = { out: "static-dist", strict: false, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--filter") args.filters.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Resolve a package.json `exports`/`main` for the root subpath under our
 * import conditions. Returns a path relative to the package root (e.g.
 * "./dist/index.js") or undefined.
 */
function resolveEntry(pkg) {
  const exp = pkg.exports;
  const fromExports = exp ? resolveExportValue(exp["."] ?? exp) : undefined;
  if (fromExports) return fromExports;
  if (typeof pkg.main === "string") return pkg.main;
  return undefined;
}

function resolveExportValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const cond of CONDITIONS) {
    if (cond in value) {
      const resolved = resolveExportValue(value[cond]);
      if (resolved) return resolved;
    }
  }
  if ("default" in value) return resolveExportValue(value.default);
  return undefined;
}

function normalizeRel(p) {
  return p.replace(/^\.\//, "").replace(/^\//, "");
}

function main() {
  const { out, strict, filters } = parseArgs(process.argv.slice(2));
  const outDir = resolvePath(ROOT, out);
  const packagesOutDir = join(outDir, "packages");
  const filtered = new Set(filters);

  if (!filtered.size) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(packagesOutDir, { recursive: true });

  // Copy dists and build manifest.
  const modules = [];
  const examples = [];
  const skipped = [];

  for (const name of readdirSync(ROOT).sort()) {
    if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;
    const toolDir = join(ROOT, name);
    if (!statSync(toolDir).isDirectory()) continue;

    const pkgPath = join(toolDir, "package.json");
    if (!existsSync(pkgPath)) {
      skipped.push(`${name} (no package.json)`);
      if (filtered.has(name)) {
        rmSync(join(packagesOutDir, name), { recursive: true, force: true });
      }
      continue;
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    const entry = resolveEntry(pkg);
    if (!entry) {
      skipped.push(`${name} (no resolvable entry point in package.json)`);
      if (filtered.has(name)) {
        rmSync(join(packagesOutDir, name), { recursive: true, force: true });
      }
      continue;
    }

    const entryRel = normalizeRel(entry);
    if (!existsSync(join(toolDir, entryRel))) {
      skipped.push(`${name} (entry ${entryRel} not found)`);
      if (filtered.has(name)) {
        rmSync(join(packagesOutDir, name), { recursive: true, force: true });
      }
      continue;
    }

    const destDir = join(packagesOutDir, name);
    const copy = !filtered.size || filtered.has(name);
    if (copy) {
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
    }

    const entryTopDir = entryRel.includes("/") ? entryRel.split("/")[0] : null;
    if (copy && entryTopDir) {
      // Entry is in a subdirectory (e.g. dist/index.js) — copy that dir + package.json.
      cpSync(join(toolDir, entryTopDir), join(destDir, entryTopDir), { recursive: true });
      cpSync(pkgPath, join(destDir, "package.json"));
    } else if (copy) {
      // Entry is at root (e.g. index.js) — copy source files directly.
      const SKIP = new Set(["node_modules", ".git", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
      cpSync(toolDir, destDir, {
        recursive: true,
        filter: (src) => {
          if (src === toolDir) return true;
          return !SKIP.has(src.slice(toolDir.length + 1).split("/")[0]);
        },
      });
    }

    // An example.js at the tool root contributes to the generated init.js.
    // For root-entry tools the wholesale copy above already included it, but
    // copying again is harmless and covers the dist-only case.
    const examplePath = join(toolDir, "example.js");
    if (existsSync(examplePath)) {
      if (copy) cpSync(examplePath, join(destDir, "example.js"));
      examples.push(`./packages/${name}/example.js`);
    }

    // Point at the tool directory; the runtime fetches its package.json and
    // resolves the entry point (validated above) itself.
    modules.push(`./packages/${name}/`);
    if (copy) {
      console.log(`[ok]    ${name} -> ./packages/${name}/ (entry: ${entryRel})`);
    }
  }

  const manifest = {
    "@patchwork": { type: "patchwork:module-settings" },
    modules,
  };
  writeFileSync(join(outDir, "modules.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(outDir, "init.js"), renderInitScript(examples));

  // The shell loads these tools cross-origin, and module `import()` is always a
  // CORS request, so the tools host must allow it. `_headers` is read by Netlify
  // (and Cloudflare Pages), so the bundle is portable across static hosts.
  writeFileSync(
    join(outDir, "_headers"),
    ["/*", "  Access-Control-Allow-Origin: *", ""].join("\n")
  );

  console.log(`\nWrote ${modules.length} modules to ${join(outDir, "modules.json")}`);
  console.log(`Wrote ${examples.length} examples to ${join(outDir, "init.js")}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
  const failed = filtered.size
    ? skipped.some((entry) => filtered.has(entry.split(" ", 1)[0]))
    : skipped.length > 0;
  if (strict && failed) process.exitCode = 1;
}

/**
 * Render the init script served next to modules.json. A shell imports it and
 * calls the default export once per fresh account, passing the automerge repo
 * and the DocHandle of the folder the example documents belong in. Each
 * example module's default export receives the repo and returns a DocLink (or
 * an array of them); a failing example is skipped so it can't spoil the rest.
 */
function renderInitScript(examples) {
  return `// GENERATED by scripts/bundle.mjs — do not edit.
const examples = ${JSON.stringify(examples, null, 2)};

export default async function init(repo, folder) {
  for (const path of examples) {
    try {
      const mod = await import(new URL(path, import.meta.url).href);
      const result = await mod.default(repo);
      const links = (Array.isArray(result) ? result : [result]).filter(Boolean);
      if (links.length) folder.change((doc) => { doc.docs.push(...links); });
    } catch (err) {
      console.warn(\`init: example \${path} failed\`, err);
    }
  }
}
`;
}

main();
