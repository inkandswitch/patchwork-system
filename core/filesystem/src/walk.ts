import {
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type Repo,
  type UrlHeads,
  isImmutableString,
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
  folderProvider,
  providerFor,
} from "./providers.js";
import { readNode } from "./resolve.js";

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
  /**
   * The last document the walk entered that has a provider (a folder, a directory, …), and its
   * pinned path. The files around the end of the path are its files.
   */
  container?: { handle: DocHandle<unknown>; pinned: string };
  /** The encoded names after the container, joined with "/": "" at the container itself. */
  tail: string;
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

  let container: { handle: DocHandle<unknown>; index: number } | undefined;
  const noteContainer = () => {
    if (at?.kind === "doc" && at.provider && !at.inside) {
      container = { handle: at.handle, index: out.length - 1 };
    }
  };

  let i = 0;
  while (true) {
    noteContainer();
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

  noteContainer();
  // The assignments are in a closure, where narrowing doesn't follow them.
  const last = container as { handle: DocHandle<unknown>; index: number } | undefined;
  return {
    handle: at.handle,
    node: at.node,
    atDocument: !at.inside,
    pinned: out.join("/"),
    canonical: !live,
    container: last && {
      handle: last.handle,
      pinned: out.slice(0, last.index + 1).join("/"),
    },
    tail: last ? out.slice(last.index + 1).join("/") : "",
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

export type FileContent = { content: string | Uint8Array; type: string };

/**
 * What a path names, read the way the service worker serves it: its bytes and type, with the
 * path's pinned form and whether the input was already canonical.
 */
export async function readPath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<(FileContent & { pinned: string; canonical: boolean }) | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end) return undefined;
  const read = await readNode(repo, end.node);
  return read && { ...read, pinned: end.pinned, canonical: end.canonical };
}

/** A file under a pinned document, and the document that holds its bytes. */
export type ListedFile = FileContent & {
  tail: string;
  documentId: DocumentId;
};

const isNested = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array) &&
  !isImmutableString(value) &&
  !("content" in value);

// Which of two spellings of one tail the walk finds: at the first level where their directory
// keys differ in length, the longer key, since lookup tries the longest prefix first.
function walkPrefers(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// How many file docs a listing reads at once.
const LIST_CONCURRENCY = 8;

/**
 * Every file under the last container a canonical pinned path enters (see
 * {@link WalkEnd.container}), keyed by tail: "" for the container itself, encoded names joined
 * with "/" below it. Folders below it are listed into only when it's a package (see `deep`);
 * otherwise they have their own doc steps. `path` may name the container or anything in it.
 * Undefined unless `path` is canonical.
 *
 * File docs are read several at once. One that can't be read is left out and its tail named in
 * `missing`, so a caller can tell a partial list from a whole one. A file reached by a link
 * without heads is read as it is now, so the list is a snapshot.
 */
export async function listFiles(
  repo: Repo,
  path: string,
  options: WalkOptions & {
    /** List into nested folders. Default: when the container has a `package.json`. */
    deep?: boolean;
  }
): Promise<{ prefix: string; files: ListedFile[]; missing: string[] } | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end?.canonical || !end.container) return undefined;
  const find = options.find ?? ((url: AutomergeUrl) => repo.find(url));
  const root = end.container.handle.doc();
  const rootProvider = providerFor(root);
  const rootId = end.container.handle.documentId;
  // A package's relative imports reach into its nested folders by name, so a package lists
  // everything under it. Anything else lists its own files.
  const deep =
    options.deep ??
    (rootProvider?.list(root) ?? []).some((child) => child.name === "package.json");

  const found = new Map<string, { keys: number[]; file: ListedFile }>();
  const missing: string[] = [];
  const tailOf = (parts: string[]) => parts.map(encodeURIComponent).join("/");
  const add = async (
    parts: string[],
    keys: number[],
    node: unknown,
    holder: DocumentId
  ) => {
    const tail = tailOf(parts);
    const existing = found.get(tail);
    if (existing && !walkPrefers(keys, existing.keys)) return;
    const read = await readNode(repo, node);
    if (read) found.set(tail, { keys, file: { ...read, tail, documentId: holder } });
  };

  // Values are read in place; links are gathered and read below.
  type Link = { parts: string[]; keys: number[]; link: AutomergeUrl };
  const entered = new Set<string>([rootId]);
  const visit = async (
    node: unknown,
    provider: PathProvider | undefined,
    holder: DocumentId,
    parts: string[],
    keys: number[]
  ): Promise<Link[]> => {
    const links: Link[] = [];
    for (const child of provider?.list(node) ?? []) {
      const names = nameSegments(provider, child.name);
      const childParts = [...parts, ...names];
      const childKeys = [...keys, names.length];
      if ("value" in child) {
        if (child.value === undefined) continue;
        await add(childParts, childKeys, child.value, holder);
        // Nested values are addressable by path only inside a directory doc.
        if (provider === directoryProvider && isNested(child.value)) {
          links.push(
            ...(await visit(child.value, provider, holder, childParts, childKeys))
          );
        }
      } else if ("link" in child) {
        links.push({ parts: childParts, keys: childKeys, link: child.link });
      }
    }
    return links;
  };

  // At most LIST_CONCURRENCY file docs read at once, nested folders included.
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (active >= LIST_CONCURRENCY) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
  };
  const release = () => {
    active--;
    queue.shift()?.();
  };

  const read = async ({ parts, keys, link }: Link): Promise<void> => {
    let below: Link[] = [];
    await acquire();
    try {
      const parsed = parseAutomergeUrl(link);
      const live = await find(
        stringifyAutomergeUrl({ documentId: parsed.documentId }),
        parsed.heads
      );
      const doc = live.view(parsed.heads ?? live.heads()).doc();
      if (doc === undefined) return;
      // A document without a provider is a file, as it is for a path that ends at it.
      const provider = providerFor(doc);
      if (!provider) {
        await add(parts, keys, doc, parsed.documentId);
      } else if (
        deep &&
        (provider === folderProvider || provider === directoryProvider) &&
        !entered.has(parsed.documentId)
      ) {
        // Into a nested folder, by name: its files are under its name here.
        entered.add(parsed.documentId);
        await add(parts, keys, doc, parsed.documentId);
        below = await visit(doc, provider, parsed.documentId, parts, keys);
      }
    } catch {
      missing.push(tailOf(parts));
    } finally {
      release();
    }
    // Read what's below after letting go of the slot, so nesting can't deadlock.
    await Promise.all(below.map(read));
  };

  await add([], [], root, rootId);
  await Promise.all((await visit(root, rootProvider, rootId, [], [])).map(read));

  return {
    prefix: end.container.pinned,
    files: [...found.values()].map(({ file }) => file),
    missing,
  };
}
