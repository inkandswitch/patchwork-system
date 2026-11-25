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
  directoryProvider,
  providerFor,
} from "./providers.js";

export type WalkOptions = {
  /** acctHash → account doc url. The roots a live or pinned account path may start at. */
  accounts: ReadonlyMap<string, AutomergeUrl>;
  /**
   * Find a document, given its bare url and the heads the walk will read it at (none: current).
   * The walk views what it returns at those heads. A resolver passes one that waits for the
   * heads to arrive, or for peers to catch up; the default is `repo.find`. A rejection fails
   * the walk.
   */
  find?: (url: AutomergeUrl, heads?: UrlHeads) => Promise<DocHandle<unknown>>;
};

/**
 * The path segments a child's name is written as: one, except a directory key, which spans
 * several. So a name reached by several spellings ("a%2Fb", or "a/b" consumed together) is
 * written one way.
 */
const nameSegments = (provider: PathProvider | undefined, name: string) =>
  provider === directoryProvider ? name.split("/") : [name];

// idhashes never change, and every walk hashes the same few documents again.
const idhashes = new Map<string, Promise<string>>();
function memoIdhash(documentId: string): Promise<string> {
  let hash = idhashes.get(documentId);
  if (!hash) {
    if (idhashes.size >= 10_000) idhashes.clear();
    idhashes.set(documentId, (hash = idhash(documentId)));
  }
  return hash;
}

export type WalkEnd = {
  /** The last document the walk entered, as a view at the heads it was read at. */
  handle: DocHandle<unknown>;
  /** Where the walk stopped: the document itself, or a value nested in it. */
  node: unknown;
  /** False when the path ends at a value inside the document rather than at the document. */
  atDocument: boolean;
  /** The pinned path, without a leading slash. */
  pinned: string;
  /**
   * True when every document the pinned path names was entered at heads the input gave: the
   * input was already pinned and means what `pinned` means. A pinned root followed by names is
   * not, since the names resolve at whatever the documents below it hold now.
   */
  canonical: boolean;
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
 * the name that led to it. A step that consumes no name (a union member) adds its own doc step.
 * Steps inside a document, and the names that lead from the last container to a document
 * without a provider (a file), stay as names: that tail is what lets a module's relative
 * imports resolve.
 *
 * Returns undefined when the path doesn't resolve. Throws only for a path that doesn't parse.
 */
export async function walkPath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<WalkEnd | undefined> {
  const { root, segments } = parsePath(path);
  const hashOf = (url: AutomergeUrl) =>
    memoIdhash(parseAutomergeUrl(url).documentId);
  const find = options.find ?? ((url: AutomergeUrl) => repo.find(url));
  const stepOf = async (handle: DocHandle<unknown>) =>
    docStep(await hashOf(handle.url), handle.heads());

  async function enter(
    url: AutomergeUrl,
    heads: UrlHeads | undefined
  ): Promise<AtDoc | undefined> {
    try {
      const parsed = parseAutomergeUrl(url);
      const at = heads ?? parsed.heads;
      const live = await find(
        stringifyAutomergeUrl({ documentId: parsed.documentId }),
        at
      );
      const handle = live.view(at ?? live.heads());
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

  // Steps that consume no name can loop (`/` bound to the account); revisiting a document with
  // as many segments left is a cycle.
  const seen = new Set<string>();
  const guard = (url: AutomergeUrl, remaining: number) => {
    const key = `${parseAutomergeUrl(url).documentId}|${remaining}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  // The names from i on, for a lookup that may consume several (a directory key like
  // "vendor/react@18.3.1/index.js"). A doc step reads as a name here: one is only taken as a step
  // at the front, and only when it matches a link.
  const namesFrom = (i: number) =>
    segments
      .slice(i)
      .map((segment) =>
        segment.kind === "name" ? segment.name : decodeURIComponent(segment.raw)
      );

  const out: string[] = [];
  // Set once a document the pinned path names was entered at its current heads.
  let live = !root.heads;
  let at: At | undefined;
  if (root.kind === "account") {
    const url = options.accounts.get(root.acctHash);
    at = url && (await enter(url, root.heads));
    if (!at) return undefined;
    out.push(docStep(root.acctHash, at.handle.heads()));
  } else {
    at = await enter(
      stringifyAutomergeUrl({ documentId: root.documentId }),
      root.heads
    );
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
        // The first binding that has the next name, the way plan9 reads a union directory.
        const names = namesFrom(i);
        for (const url of at.members) {
          const candidate = await enter(url, undefined);
          if (
            !names.length ||
            (candidate?.provider && candidate.provider.lookup(candidate.node, names))
          ) {
            member = url;
            next = candidate;
            break;
          }
        }
        if (!member || !guard(member, segments.length - i)) return undefined;
        live = true;
      }
      if (!next) return undefined;
      out.push(await stepOf(next.handle));
      at = next;
      continue;
    }

    if (!segment) break;

    if (segment.kind === "doc") {
      const children: Child[] = at.provider?.list(at.node) ?? [];
      const links = children.flatMap((child) =>
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
    // A step inside the document must use a name, or the walk would never move on; and none
    // can use more names than there are.
    if (consumed > names.length || (consumed < 1 && "value" in child)) {
      return undefined;
    }
    const written =
      consumed === 0
        ? []
        : child.name
          ? nameSegments(at.provider, child.name).map(encodeURIComponent)
          : names.slice(0, consumed).map(encodeURIComponent);
    i += consumed;

    if ("value" in child) {
      out.push(...written);
      at = { ...at, node: child.value, inside: true };
    } else if ("union" in child) {
      out.push(...written);
      at = { kind: "union", members: child.union };
    } else {
      if (!consumed && !guard(child.link, segments.length - i)) return undefined;
      const next = await enter(child.link, undefined);
      if (!next) return undefined;
      if (next.provider || !consumed) {
        out.push(await stepOf(next.handle));
        live = true;
      } else out.push(...written);
      at = next;
    }
  }

  return {
    handle: at.handle,
    node: at.node,
    atDocument: !at.inside,
    pinned: out.join("/"),
    canonical: !live,
  };
}

/**
 * The document a live or pinned path names. For a canonical pinned path (see
 * {@link WalkEnd.canonical}) that is a view at the heads it was read at. Anything else gets the
 * live handle. Undefined if the path doesn't resolve, or ends at a value inside a document.
 */
export async function resolveLivePath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<DocHandle<unknown> | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end || !end.atDocument) return undefined;
  return end.canonical
    ? end.handle
    : repo.find(stringifyAutomergeUrl({ documentId: end.handle.documentId }));
}
