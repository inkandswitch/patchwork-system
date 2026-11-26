/**
 * The tools that open a doc of `type`, one group per tool id. Tools made for
 * the type come before tools for anything, then by name. A group lists every
 * package that brings that id, with `opens` (the one opening the doc by id
 * gets) first.
 *
 * @param {Array<{id: string, name?: string, supportedDatatypes?: "*" | string[], unlisted?: boolean, forTitleBar?: boolean}>} tools
 * @param {string} type
 * @param {(id: string) => object | undefined} opens
 */
export function groupTools(tools, type, opens) {
  const groups = new Map();
  for (const tool of tools) {
    if (tool.unlisted || tool.forTitleBar) continue;
    let group = groups.get(tool.id);
    if (!group) {
      group = { id: tool.id, name: tool.name || tool.id, copies: [] };
      groups.set(tool.id, group);
    }
    group.copies.push(tool);
  }
  const madeFor = (group) =>
    group.copies.some((tool) => [tool.supportedDatatypes].flat().includes(type));
  for (const group of groups.values()) {
    const winner = opens(group.id);
    group.copies.sort((a, b) => (b === winner) - (a === winner));
    group.name = group.copies[0].name || group.id;
  }
  return [...groups.values()].sort(
    (a, b) => madeFor(b) - madeFor(a) || a.name.localeCompare(b.name)
  );
}

/** A package's name, as its package.json gives it. */
export function packageName(entry) {
  const json = entry.packageJson ?? {};
  return json.title || json.name || entry.key;
}

export const isAutomerge = (url) => url.startsWith("automerge:");

const person = (who) => (typeof who === "string" ? who : who?.name);
const link = (where) => (typeof where === "string" ? where : where?.url);

/**
 * What a person might want to know about a package, as [label, value]
 * pairs, leaving out what it doesn't say.
 */
export function aboutPackage(entry) {
  const json = entry.packageJson ?? {};
  return [
    ["name", json.title && json.name !== json.title ? json.name : undefined],
    ["version", json.version],
    ["description", json.description],
    ["author", person(json.author)],
    ["license", json.license],
    ["homepage", json.homepage ?? link(json.repository)],
    [isAutomerge(entry.importUrl) ? "heads" : "sha-256", short(entry.version)],
    ["added", entry.addedAt ? new Date(entry.addedAt).toLocaleString() : undefined],
    ["url", entry.importUrl],
  ].filter(([, value]) => value);
}

/** A version (heads "a|b", or a sha-256) cut down to something to glance at. */
export function short(version) {
  return version
    .split("|")
    .map((part) => part.slice(0, 8))
    .join(" ");
}

const ADDED_BY = {
  "package-list": "package list",
  "package-url": "package-url",
  suggested: "suggested",
  js: "js",
};

/**
 * Who added a package, once each: `label`, what it added (`entry`, a listed
 * url or a script's), and for a package list, the lists that have it, as
 * `listsWith` says.
 */
export function adders(entry, listsWith = () => []) {
  const seen = new Map();
  for (const added of entry.addedBy) {
    const what = added.by === "package-list" ? added.entry : added.url;
    const key = `${added.by} ${what ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      label: ADDED_BY[added.by] ?? added.by,
      entry: what,
      lists: added.by === "package-list" ? listsWith(added.entry) : [],
    });
  }
  return [...seen.values()];
}

/**
 * The versions of a package this browser has seen, newest first, one each:
 * the one in memory and the saved ones.
 */
export function seenVersions(current, saved) {
  const byVersion = new Map();
  for (const entry of [current, ...saved].filter(Boolean)) {
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, entry);
  }
  return [...byVersion.values()].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}

/** The url for a package doc at `heads`. */
export function atHeads(key, heads) {
  return `${key}#${heads.join("|")}`;
}

/** The sha-256 of a package.json body, as the package database versions it. */
export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
