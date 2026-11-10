// Maps a stamped location (`path:line:column` inside a writer's package) back
// to its source, through the source map built next to the file.
import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { resolvePath } from "@inkandswitch/patchwork-filesystem";

export type Location = { path: string; line: number; column: number };
/** Where a location came from in the source; `line` and `column` count from 1. */
export type Origin = { source: string; line: number; column: number; name?: string };

export function parseLocation(at: string): Location | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(at);
  return match ? { path: match[1]!, line: Number(match[2]), column: Number(match[3]) } : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...B64].map((c, i) => [c, i]));

/** One segment's fields, each relative to the one before it, as the map stores them. */
function decodeSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char);
    if (digit === undefined) return values;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

type RawMap = { sources?: string[]; names?: string[]; mappings?: string; sourceRoot?: string };

/**
 * Where generated `line:column` (both from 1, as a stack has them) came from:
 * the last mapping on that line at or before the column.
 */
export function originalPosition(map: RawMap, line: number, column: number): Origin | null {
  if (typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
  const lines = map.mappings.split(";");
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  let found: Origin | null = null;
  // The source fields carry across lines, so every line before has to be read.
  for (let l = 0; l < lines.length && l < line; l++) {
    let generated = 0;
    for (const segment of lines[l]!.split(",")) {
      if (!segment) continue;
      const fields = decodeSegment(segment);
      generated += fields[0] ?? 0;
      if (fields.length < 4) continue;
      source += fields[1]!;
      sourceLine += fields[2]!;
      sourceColumn += fields[3]!;
      if (fields.length >= 5) name += fields[4]!;
      if (l === line - 1 && generated <= column - 1) {
        const named = fields.length >= 5 ? map.names?.[name] : undefined;
        found = {
          source: cleanSource(map.sources[source] ?? "?", map.sourceRoot),
          line: sourceLine + 1,
          column: sourceColumn + 1,
          ...(named ? { name: named } : {}),
        };
      }
    }
  }
  return found;
}

/** A source path without the bundler's prefixes: `webpack://x/./src/a.ts` → `src/a.ts`. */
function cleanSource(source: string, root = ""): string {
  let path = (root && !root.endsWith("/") ? `${root}/` : root) + source;
  path = path.replace(/^[a-z]+:\/\/[^/]*\//, "");
  while (path.startsWith("../") || path.startsWith("./")) path = path.slice(path.indexOf("/") + 1);
  return path;
}

type Finder = Pick<Repo, "find">;

async function readText(repo: Finder, writer: string, path: string): Promise<string | undefined> {
  if (writer.startsWith("automerge:")) {
    const root = (await repo.find(writer as never)) as DocHandle<unknown>;
    const resolved = await resolvePath(repo as Repo, root, path.split("/"));
    if (!resolved) return undefined;
    return typeof resolved.content === "string" ? resolved.content : new TextDecoder().decode(resolved.content);
  }
  const base = writer.startsWith("site@") ? `${location.origin}/` : writer;
  const response = await fetch(new URL(path, base));
  return response.ok ? response.text() : undefined;
}

/**
 * Maps locations to their sources, fetching each file's map once. A writer
 * whose files can't be read, or that shipped no map, leaves its locations as
 * they are.
 */
export function createSourceMapper(repo: Finder, arrived: () => void) {
  const maps = new Map<string, Promise<RawMap | null>>();
  const origins = new Map<string, Origin | null>();

  const mapFor = (writer: string, path: string) => {
    const key = `${writer}\n${path}`;
    let map = maps.get(key);
    if (!map) {
      map = readText(repo, writer, `${path}.map`)
        .then((text) => (text ? (JSON.parse(text) as RawMap) : null))
        .catch(() => null);
      maps.set(key, map);
    }
    return map;
  };

  /** The source of `at` in `writer` if known yet; looks it up in the background otherwise. */
  return (writer: string, at: string): Origin | null | undefined => {
    const key = `${writer}\n${at}`;
    if (origins.has(key)) return origins.get(key);
    origins.set(key, null);
    const location = parseLocation(at);
    if (!location) return null;
    void mapFor(writer, location.path).then((map) => {
      const origin = map ? originalPosition(map, location.line, location.column) : null;
      if (!origin) return;
      origins.set(key, origin);
      arrived();
    });
    return undefined;
  };
}
