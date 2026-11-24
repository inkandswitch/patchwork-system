import { posix } from "node:path";

export interface Entry {
  /** The file to build, as written in the export's `source`. */
  in: string;
  /** Where the export says the built file is, if it says. */
  import?: string;
}

type Conditions = { [condition: string]: unknown };

/**
 * The subpath exports in a package.json's `exports`, whatever shape it's
 * written in: `{ ".": …, "./tool": … }`, or a bare conditions object or
 * string standing in for `"."`.
 */
function subpaths(exports: unknown): unknown[] {
  if (exports == null || typeof exports != "object") return [exports];
  const keys = Object.keys(exports);
  if (keys.length && keys.every((key) => key.startsWith("."))) {
    return Object.values(exports);
  }
  return [exports];
}

/**
 * The entries a package's `exports` describes. Only an export with a `source`
 * is built. Anything else (a stylesheet as a bare string, say) is a file the
 * package serves as it is.
 */
export function entriesFromExports(exports: unknown): Entry[] {
  const entries: Entry[] = [];
  for (const target of subpaths(exports)) {
    if (target == null || typeof target != "object") continue;
    const { source, import: imported } = target as Conditions;
    if (typeof source != "string") continue;
    entries.push(
      typeof imported == "string"
        ? { in: source, import: imported }
        : { in: source }
    );
  }
  return entries;
}

/**
 * The directory every entry's `import` sits in, which becomes the outdir when
 * none is given: `dist` for `./dist/index.js` and `./dist/lib/tool.js`.
 */
export function commonOutdir(entries: Entry[]): string | undefined {
  const dirs = entries
    .filter((entry) => entry.import != null)
    .map((entry) => posix.normalize(posix.dirname(entry.import!)).split("/"));
  if (!dirs.length) return;
  const common = dirs.reduce((shared, dir) => {
    let i = 0;
    while (i < shared.length && shared[i] == dir[i]) i++;
    return shared.slice(0, i);
  });
  const outdir = common.join("/");
  return outdir && outdir != "." ? outdir : undefined;
}

/**
 * Each entry with the path to write it to, relative to the outdir and without
 * the `.js`, so it lands where its `import` says. `outdir` is relative to the
 * package, like the paths in package.json.
 * An entry with no `import` is written to the top of the outdir under its own
 * name: src/thing.ts to thing.js.
 */
export function entryOutputs(
  entries: Entry[],
  outdir: string
): { in: string; out: string }[] {
  return entries.map((entry) => {
    if (entry.import == null) {
      return { in: entry.in, out: posix.parse(entry.in).name };
    }
    const out = posix.relative(
      posix.normalize(outdir),
      posix.normalize(entry.import)
    );
    if (out.startsWith("..")) {
      throw new Error(
        `the export of ${entry.in} imports ${entry.import}, which is outside ` +
          `the outdir (${outdir}). Point its \`import\` inside ${outdir}, ` +
          `or pass a different outdir.`
      );
    }
    if (!out.endsWith(".js")) {
      throw new Error(
        `the export of ${entry.in} imports ${entry.import}. Entries are ` +
          `written as .js, so its \`import\` has to end in .js.`
      );
    }
    return { in: entry.in, out: out.slice(0, -".js".length) };
  });
}
