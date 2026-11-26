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

const ADDED_BY = {
  "package-list": "package list",
  "package-url": "package-url",
  suggested: "suggested",
  js: "js",
};

/** Who added a package, for a person: "package list, suggested". */
export function addedBy(entry) {
  return [...new Set(entry.addedBy.map((added) => ADDED_BY[added.by] ?? added.by))]
    .join(", ");
}
