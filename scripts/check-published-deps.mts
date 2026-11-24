// Fails when a public package's dependencies, as `pnpm publish` would write
// them, differ from what that same version has on npm, and no pending
// changeset bumps it.
//
// Changesets only knows about the package.json files it's told about. A
// `catalog:` dependency's version lives in pnpm-workspace.yaml, so moving the
// catalog changes what every package that uses it would publish without
// changing any of their package.json files. If nothing else bumps a package,
// the version on npm keeps the old dependency. (This is how
// @inkandswitch/patchwork-bootloader@0.9.7 kept automerge-repo
// 2.6.0-subduction.49 after the catalog moved to @chee/automerge-repo.)
//
// `workspace:` dependencies are skipped: changesets bumps those itself
// (`updateInternalDependencies`). A version that isn't on npm yet is skipped
// too: it'll be published as it is.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type Manifest = {
  name?: string;
  version?: string;
  private?: boolean;
} & Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;

// the default catalog, from pnpm-workspace.yaml: `catalog:` and its indented
// `name: spec` lines (no yaml parser in the root's dependencies, and this
// block is that simple)
function readCatalog(): Map<string, string> {
  const catalog = new Map<string, string>();
  const unquote = (text: string) => text.trim().replace(/^(["'])(.*)\1$/, "$2");
  let inside = false;
  for (const line of readFileSync(
    join(root, "pnpm-workspace.yaml"),
    "utf8"
  ).split("\n")) {
    if (/^catalog:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+("[^"]+"|'[^']+'|[^:\s]+):\s*(.+?)\s*$/.exec(line);
    if (entry) catalog.set(unquote(entry[1]), unquote(entry[2]));
  }
  return catalog;
}

// every public package in the workspace (`pnpm ls` knows the globs)
function workspacePackages(): { dir: string; manifest: Manifest }[] {
  const listed = JSON.parse(
    execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
    })
  ) as { path: string }[];
  return listed
    .map(({ path }) => ({
      dir: path,
      manifest: JSON.parse(
        readFileSync(join(path, "package.json"), "utf8")
      ) as Manifest,
    }))
    .filter(
      ({ manifest }) => manifest.name && manifest.version && !manifest.private
    );
}

// the packages pending changesets will bump
function pendingBumps(): Set<string> {
  const dir = join(root, ".changeset");
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const front = /^---\n([\s\S]*?)\n---/.exec(
      readFileSync(join(dir, file), "utf8")
    );
    for (const line of front?.[1].split("\n") ?? []) {
      const name = /^\s*["']?([^"':]+)["']?\s*:/.exec(line);
      if (name) names.add(name[1].trim());
    }
  }
  return names;
}

async function published(name: string, version: string) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`;
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return (await response.json()) as Manifest;
}

const catalog = readCatalog();
const pending = pendingBumps();
const problems: string[] = [];

await Promise.all(
  workspacePackages().map(async ({ manifest }) => {
    const { name, version } = manifest as Required<Manifest>;
    const differences: string[] = [];
    let remote: Manifest | undefined;
    try {
      remote = await published(name, version);
    } catch (error) {
      problems.push(`${name}@${version}: couldn't read it from npm (${error})`);
      return;
    }
    if (!remote) return;
    for (const field of FIELDS) {
      const local = manifest[field] ?? {};
      const theirs = remote[field] ?? {};
      for (const dep of new Set([
        ...Object.keys(local),
        ...Object.keys(theirs),
      ])) {
        let spec: string | undefined = local[dep];
        if (spec?.startsWith("workspace:")) continue;
        if (spec === "catalog:" || spec === "catalog:default") {
          spec = catalog.get(dep);
          if (spec === undefined) {
            differences.push(
              `${field}.${dep}: "catalog:", but the catalog hasn't got it`
            );
            continue;
          }
        } else if (spec?.startsWith("catalog:")) {
          differences.push(
            `${field}.${dep}: named catalogs ("${spec}") aren't read by this check`
          );
          continue;
        }
        if (spec !== theirs[dep]) {
          differences.push(
            `${field}.${dep}: npm has ${theirs[dep] ?? "nothing"}, publishing now would give ${spec ?? "nothing"}`
          );
        }
      }
    }
    if (differences.length && !pending.has(name)) {
      problems.push(
        `${name}@${version} would publish different dependencies from the ${version} on npm, ` +
          `and no changeset bumps it:\n` +
          differences.map((line) => `    ${line}`).join("\n")
      );
    }
  })
);

if (problems.length) {
  console.error(problems.join("\n\n"));
  console.error(
    `\nadd a changeset for each (\`pnpm changeset\`), so the new dependencies get published.`
  );
  process.exit(1);
}
console.log(
  "every public package's dependencies match npm, or a changeset bumps it"
);
