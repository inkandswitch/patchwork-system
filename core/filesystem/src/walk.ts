import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import {
  type DocStep,
  docStep,
  formatHeads,
  idhash,
  parsePath,
} from "./paths.js";
import {
  type Child,
  type Lookup,
  type PathProvider,
  accountProvider,
  branchesProvider,
  defaultBranch,
  providerFor,
} from "./providers.js";
import { documentBaseOrigin } from "./urls.js";

export type WalkOptions = {
  /** acctHash → account doc url. The roots a live or pinned account path may start at. */
  accounts: ReadonlyMap<string, AutomergeUrl>;
};

export type WalkEnd = {
  /** The last document the walk entered, as a view at the heads it was read at. */
  handle: DocHandle<unknown>;
  /** Where the walk stopped: the document itself, or a value nested in it. */
  node: unknown;
  /** False when the path ends at a value inside the document rather than at the document. */
  atDocument: boolean;
  /** The pinned path, without a leading slash. */
  pinned: string;
};

/** Where a walk is: inside a document, or at a mount whose binding the next step picks. */
type At =
  | {
      kind: "doc";
      handle: DocHandle<unknown>;
      node: unknown;
      provider?: PathProvider;
      inside: boolean;
    }
  | { kind: "union"; members: AutomergeUrl[] };

type AtDoc = Extract<At, { kind: "doc" }>;

/**
 * Walk a live or pinned path and write its pinned form as it goes.
 *
 * Every document that has a provider (a container) is written as `<idhash>@<heads>` in place of
 * the name that led to it. A step that consumes no name (a union member, a branches doc's
 * default) adds its own doc step. Steps inside a document, and the names that lead from the last
 * container to a document without a provider (a file), stay as names: that tail is what lets a
 * module's relative imports resolve.
 *
 * Returns undefined when the path doesn't resolve. Throws only for a path that doesn't parse.
 */
export async function walkPath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<WalkEnd | undefined> {
  const { root, segments } = parsePath(path);
  const hashes = new Map<string, Promise<string>>();
  const hashOf = (url: AutomergeUrl) => {
    const { documentId } = parseAutomergeUrl(url);
    let hash = hashes.get(documentId);
    if (!hash) hashes.set(documentId, (hash = idhash(documentId)));
    return hash;
  };
  const stepOf = async (handle: DocHandle<unknown>) =>
    docStep(await hashOf(handle.url), handle.heads());

  async function enter(
    url: AutomergeUrl,
    heads?: UrlHeads
  ): Promise<AtDoc | undefined> {
    try {
      const parsed = parseAutomergeUrl(url);
      const live = await repo.find(
        stringifyAutomergeUrl({ documentId: parsed.documentId })
      );
      const handle = live.view(heads ?? parsed.heads ?? live.heads());
      const node = handle.doc();
      if (node === undefined) return undefined;
      return { kind: "doc", handle, node, provider: providerFor(node), inside: false };
    } catch {
      return undefined;
    }
  }

  async function matchLink(links: AutomergeUrl[], step: DocStep) {
    for (const link of links) {
      if ((await hashOf(link)) === step.idhash) return link;
    }
    return undefined;
  }

  // Steps that consume no name can loop (a branches doc whose default is itself, `/` bound to the
  // account); revisiting a document with as many segments left is a cycle.
  const seen = new Set<string>();
  const guard = (url: AutomergeUrl, remaining: number) => {
    const key = `${parseAutomergeUrl(url).documentId}|${remaining}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  // The run of names starting at i. A doc step that matched no link reads as a name.
  const namesFrom = (i: number) => {
    const names: string[] = [];
    for (let j = i; j < segments.length; j++) {
      const segment = segments[j];
      if (segment.kind === "name") names.push(segment.name);
      else if (j === i) names.push(decodeURIComponent(segment.raw));
      else break;
    }
    return names;
  };

  const out: string[] = [];
  let at: At | undefined;
  if (root.kind === "account") {
    const url = options.accounts.get(root.acctHash);
    at = url && (await enter(url, root.heads));
    if (!at) return undefined;
    out.push(docStep(root.acctHash, at.handle.heads()));
  } else {
    at = await enter(stringifyAutomergeUrl({ documentId: root.documentId }), root.heads);
    if (!at) return undefined;
    out.push(`automerge:${root.documentId}@${formatHeads(root.heads)}`);
  }

  let i = 0;
  while (true) {
    const segment = segments[i] as (typeof segments)[number] | undefined;

    if (at.kind === "union") {
      let member: AutomergeUrl | undefined;
      let next: AtDoc | undefined;
      if (segment?.kind === "doc") {
        member = await matchLink(at.members, segment);
        if (member) {
          i++;
          if (!guard(member, segments.length - i)) return undefined;
          next = await enter(member, segment.heads);
        }
      }
      if (!member) {
        const names = namesFrom(i);
        for (const url of at.members) {
          const candidate = await enter(url);
          if (!names.length || candidate?.provider?.lookup(candidate.node, names)) {
            member = url;
            next = candidate;
            break;
          }
        }
        if (!member || !guard(member, segments.length - i)) return undefined;
      }
      if (!next) return undefined;
      out.push(await stepOf(next.handle));
      at = next;
      continue;
    }

    if (!segment) {
      // A path that ends at a branches doc stands for its default branch.
      if (at.provider !== branchesProvider || at.inside) break;
      const link = defaultBranch(at.node);
      if (!link || !guard(link, 0)) return undefined;
      const next = await enter(link);
      if (!next) return undefined;
      out.push(await stepOf(next.handle));
      at = next;
      continue;
    }

    if (segment.kind === "doc") {
      const links = (at.provider?.list(at.node) ?? []).flatMap((child) =>
        "link" in child ? [child.link] : "union" in child ? child.union : []
      );
      const link = await matchLink(links, segment);
      if (link) {
        const next = await enter(link, segment.heads);
        if (!next) return undefined;
        out.push(await stepOf(next.handle));
        at = next;
        i++;
        continue;
      }
    }

    // A document without a provider has no children.
    if (!at.provider) return undefined;
    const names = namesFrom(i);
    const found: Lookup | undefined = at.provider.lookup(at.node, names);
    if (!found) return undefined;
    const { child, consumed }: Lookup = found;
    const written = names.slice(0, consumed).map(encodeURIComponent);
    i += consumed;

    if ("value" in child) {
      out.push(...written);
      at = { ...at, node: child.value, inside: true };
    } else if ("union" in child) {
      out.push(...written);
      at = { kind: "union", members: child.union };
    } else {
      if (!consumed && !guard(child.link, segments.length - i)) return undefined;
      const next = await enter(child.link);
      if (!next) return undefined;
      if (next.provider || !consumed) out.push(await stepOf(next.handle));
      else out.push(...written);
      at = next;
    }
  }

  return {
    handle: at.handle,
    node: at.node,
    atDocument: !at.inside,
    pinned: out.join("/"),
  };
}

/**
 * The document a live or pinned path names: the live handle for a live path, a view at the
 * pinned heads for a pinned one. Undefined if the path doesn't resolve, or ends at a value inside
 * a document.
 */
export async function resolveLivePath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<DocHandle<unknown> | undefined> {
  const { root } = parsePath(path);
  const end = await walkPath(repo, path, options);
  if (!end?.atDocument) return undefined;
  if (root.heads) return end.handle;
  return repo.find(stringifyAutomergeUrl({ documentId: end.handle.documentId }));
}

export async function pinnedPath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<string | undefined> {
  return (await walkPath(repo, path, options))?.pinned;
}

/** The pinned service worker URL for a path, for fetching or importing. */
export async function pinPath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<string | undefined> {
  const pinned = await pinnedPath(repo, path, options);
  return pinned && `${documentBaseOrigin()}/@/${pinned}`;
}

/** Every binding's children, concatenated in binding order. */
export async function listUnion(
  repo: Repo,
  urls: AutomergeUrl[]
): Promise<Child[]> {
  const lists = await Promise.all(
    urls.map(async (url) => {
      try {
        const doc = (await repo.find(url)).doc();
        return providerFor(doc)?.list(doc) ?? [];
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

/**
 * A document's children. For an account, `/`'s union is expanded and each mount shadows a
 * same-named entry in it; mounts stay as union children.
 */
export async function listChildren(
  repo: Repo,
  handle: DocHandle<unknown>
): Promise<Child[]> {
  const doc = handle.doc();
  const provider = providerFor(doc);
  if (!provider) return [];
  const children = provider.list(doc);
  if (provider !== accountProvider) return children;

  const mounts = children.filter((child) => child.name !== "");
  const root = children.find((child) => child.name === "");
  const shadowed = new Set(mounts.map((child) => child.name));
  const rootChildren =
    root && "union" in root ? await listUnion(repo, root.union) : [];
  return [
    ...rootChildren.filter((child) => !shadowed.has(child.name)),
    ...mounts,
  ];
}
