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
  type ExtraProviders,
  type Lookup,
  type SubSegment,
  directoryProvider,
  folderProvider,
  type PathProvider,
  accountProvider,
  branchesProvider,
  defaultBranch,
  providerFor,
  valueAt,
} from "./providers.js";
import { buildFileList } from "./file-list.js";
import { readNode } from "./resolve.js";
import { documentBaseOrigin } from "./urls.js";

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
  /** Providers for documents no built-in walks. A tab passes the ones packages register. */
  providers?: ExtraProviders;
};

/** The built-in provider for `doc`, else one of `extra`'s; one that fails is none. */
async function providerOf(
  doc: unknown,
  extra?: ExtraProviders
): Promise<PathProvider | undefined> {
  const builtIn = providerFor(doc);
  if (builtIn || !extra) return builtIn;
  try {
    return await extra(doc);
  } catch {
    return undefined;
  }
}

// A package's provider is package code: one that throws has no children here.
function lookUp(provider: PathProvider, node: unknown, names: string[]): Lookup | undefined {
  try {
    return provider.lookup(node, names);
  } catch {
    return undefined;
  }
}

function listOf(provider: PathProvider | undefined, node: unknown): Child[] {
  try {
    const children = provider?.list(node);
    return Array.isArray(children) ? children : [];
  } catch {
    return [];
  }
}

/**
 * The path segments a child's name is written as: one, except a directory key, which spans
 * several. The walk and file lists both write it this way, so a name reached by several
 * spellings ("a%2Fb", or "a/b" consumed together) pins to the one tail its list has.
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
   * The last document the walk entered that has a provider (a folder, a directory, …): its
   * pinned path, without its own `~listHash`, and that list hash if the input gave one. Its file
   * list covers the files around the end of the path.
   */
  container?: { handle: DocHandle<unknown>; pinned: string; listHash?: string };
  /** The encoded names after the container, joined with "/": "" at the container itself. */
  tail: string;
  /** Where the walk ended inside the document, when that is a sub-document: `handle.sub(...sub)`. */
  sub?: SubSegment[];
};

/** Where a walk is: inside a document, or at a mount whose binding the next step picks. */
type At =
  | {
      kind: "doc";
      handle: DocHandle<unknown>;
      node: unknown;
      provider?: PathProvider;
      inside: boolean;
      /** The segments from the document to `node`, while every step inside was a sub-document. */
      sub?: SubSegment[];
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
  const hashOf = (url: AutomergeUrl) =>
    memoIdhash(parseAutomergeUrl(url).documentId);
  const find = options.find ?? ((url: AutomergeUrl) => repo.find(url));
  const stepOf = async (handle: DocHandle<unknown>) =>
    docStep(await hashOf(handle.url), handle.heads());

  // Package providers apply to a document the walk goes on through, and to one named by a doc
  // step (only a container is ever written as one, so a pinned prefix stays its container). A
  // document a path ends at *by name* is a container or a file by the built-ins' call, so a path
  // pins the same with or without a package's provider, and a plugin installed later doesn't
  // change what an existing pinned URL means.
  async function enter(
    url: AutomergeUrl,
    heads: UrlHeads | undefined,
    through: boolean
  ): Promise<AtDoc | undefined> {
    try {
      const parsed = parseAutomergeUrl(url);
      // A link to a sub-document: walking it as the whole document would name the wrong thing.
      if (parsed.segments?.length) return undefined;
      const at = heads ?? parsed.heads;
      const live = await find(
        stringifyAutomergeUrl({ documentId: parsed.documentId }),
        at
      );
      const handle = live.view(at ?? live.heads());
      const node = handle.doc();
      if (node === undefined) return undefined;
      const provider = through ? await providerOf(node, options.providers) : providerFor(node);
      return { kind: "doc", handle, node, provider, inside: false };
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
  // Index in `out` → the file list hash the input gave that doc step.
  const lists = new Map<number, string>();
  const render = (from: number, to: number) =>
    out
      .slice(from, to)
      .map((step, j) => (lists.has(from + j) ? `${step}~${lists.get(from + j)}` : step))
      .join("/");
  // Set once a document the pinned path names was entered at its current heads.
  let live = !root.heads;
  let at: At | undefined;
  if (root.kind === "account") {
    const url = options.accounts.get(root.acctHash);
    at = url && (await enter(url, root.heads, true));
    if (!at) return undefined;
    out.push(docStep(root.acctHash, at.handle.heads()));
    if (root.listHash) lists.set(0, root.listHash);
  } else {
    at = await enter(
      stringifyAutomergeUrl({ documentId: root.documentId }),
      root.heads,
      true
    );
    if (!at) return undefined;
    out.push(`automerge:${root.documentId}@${formatHeads(root.heads)}`);
    if (root.listHash) lists.set(0, root.listHash);
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
      let listHash: string | undefined;
      if (segment?.kind === "doc") {
        member = await matchLink(at.members, segment);
        if (member) {
          listHash = segment.listHash;
          i++;
          if (!guard(member, segments.length - i)) return undefined;
          next = await enter(member, segment.heads, true);
        }
      }
      if (!member) {
        const names = namesFrom(i);
        for (const url of at.members) {
          const candidate = await enter(url, undefined, names.length > 0);
          if (
            !names.length ||
            (candidate?.provider && lookUp(candidate.provider, candidate.node, names))
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
      if (listHash) lists.set(out.length - 1, listHash);
      at = next;
      continue;
    }

    if (!segment) {
      // A path that ends at a branches doc stands for its default branch.
      if (at.provider !== branchesProvider || at.inside) break;
      const link = defaultBranch(at.node);
      if (!link || !guard(link, 0)) return undefined;
      const next = await enter(link, undefined, false);
      if (!next) return undefined;
      out.push(await stepOf(next.handle));
      live = true;
      at = next;
      continue;
    }

    if (segment.kind === "doc") {
      const links = listOf(at.provider, at.node).flatMap((child) =>
        "link" in child ? [child.link] : "union" in child ? child.union : []
      );
      const link = await matchLink(links, segment);
      if (link) {
        const next = await enter(link, segment.heads, true);
        if (!next) return undefined;
        out.push(await stepOf(next.handle));
        if (segment.listHash) lists.set(out.length - 1, segment.listHash);
        at = next;
        i++;
        continue;
      }
    }

    // A document without a provider has no children.
    if (!at.provider) return undefined;
    const names = namesFrom(i);
    const found: Lookup | undefined = lookUp(at.provider, at.node, names);
    if (!found) return undefined;
    const { child, consumed }: Lookup = found;
    // A step inside the document must use a name, or the walk would never move on; and none
    // can use more names than there are.
    if (consumed > names.length || (consumed < 1 && ("value" in child || "sub" in child))) {
      return undefined;
    }
    const written =
      consumed === 0
        ? []
        : typeof child.name === "string" && child.name
          ? nameSegments(at.provider, child.name).map(encodeURIComponent)
          : names.slice(0, consumed).map(encodeURIComponent);
    i += consumed;

    if ("value" in child) {
      out.push(...written);
      at = { ...at, node: child.value, inside: true, sub: undefined };
    } else if ("sub" in child) {
      const node = valueAt(at.node, child.sub);
      if (node === undefined) return undefined;
      out.push(...written);
      const sub: SubSegment[] | undefined = at.inside && !at.sub ? undefined : [...(at.sub ?? []), ...child.sub];
      at = { ...at, node, inside: true, sub };
    } else if ("union" in child) {
      out.push(...written);
      at = { kind: "union", members: child.union };
    } else {
      if (!consumed && !guard(child.link, segments.length - i)) return undefined;
      const next = await enter(child.link, undefined, i < segments.length);
      if (!next) return undefined;
      if (next.provider || !consumed) {
        out.push(await stepOf(next.handle));
        live = true;
      } else out.push(...written);
      at = next;
    }
  }

  noteContainer();
  return {
    handle: at.handle,
    node: at.node,
    atDocument: !at.inside,
    pinned: render(0, out.length),
    canonical: !live,
    container: container && {
      handle: container.handle,
      pinned: [render(0, container.index), out[container.index]]
        .filter(Boolean)
        .join("/"),
      listHash: lists.get(container.index),
    },
    tail: container ? out.slice(container.index + 1).join("/") : "",
    ...(at.sub ? { sub: at.sub } : {}),
  };
}

/**
 * The document a live or pinned path names. For a canonical pinned path (see
 * {@link WalkEnd.canonical}) that is a view at the heads it was read at; a file reached by name
 * after the last pinned document is read at its current heads, or the heads its link carries.
 * Anything else gets the live handle. A path that ends at a sub-document gets that handle's
 * sub-handle. Undefined if the path doesn't resolve, or ends at any other value inside a
 * document.
 */
export async function resolveLivePath(
  repo: Repo,
  path: string,
  options: WalkOptions
): Promise<DocHandle<unknown> | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end || (!end.atDocument && !end.sub)) return undefined;
  const handle = end.canonical
    ? end.handle
    : await repo.find(stringifyAutomergeUrl({ documentId: end.handle.documentId }));
  return end.sub ? handle.sub(...end.sub) : handle;
}

/**
 * A file list couldn't read every file it covers. A pinned URL never changes meaning, so a
 * list missing a file would make it answer 404 for good; pin again once they can be read.
 */
export class IncompleteFileListError extends Error {
  name = "IncompleteFileListError";
  constructor(readonly missing: string[]) {
    super(`couldn't read ${missing.join(", ")} to pin them`);
  }
}

/**
 * The pinned form of a path, with a file list on the last container it enters: every file
 * under that container, or with `only: "end"`, only the one the path ends at (what a live →
 * pinned redirect hands out). Returns the path and the list's bytes, which whoever pins hands to
 * the service worker. No list if the path enters no container. Throws
 * {@link IncompleteFileListError} rather than pin a list missing a file it should cover.
 */
export async function pinnedPath(
  repo: Repo,
  path: string,
  options: WalkOptions & {
    findFile?: WalkOptions["find"];
    only?: "end";
    isProtected?: (documentId: DocumentId) => boolean;
  }
): Promise<{ path: string; list?: Uint8Array } | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end) return undefined;
  if (!end.container) return { path: end.pinned };
  // A path that ends at a container lists the whole container; one that ends
  // at a file, just that file.
  const atContainer = end.tail === "" && end.atDocument;
  const built = await buildFileList(repo, end.container.pinned, {
    ...options,
    only: options.only === "end" && !atContainer ? [end.tail] : undefined,
  });
  if (!built) return { path: end.pinned };
  if (built.missing.length) throw new IncompleteFileListError(built.missing);
  const listed = `${end.container.pinned}~${built.listHash}`;
  return { path: end.tail ? `${listed}/${end.tail}` : listed, list: built.bytes };
}

/** The pinned service worker URL for a path, for fetching or importing, and its file list. */
export async function pinPath(
  repo: Repo,
  path: string,
  options: Parameters<typeof pinnedPath>[2]
): Promise<{ url: string; list?: Uint8Array } | undefined> {
  const pinned = await pinnedPath(repo, path, options);
  return pinned && { url: `${documentBaseOrigin()}/@/${pinned.path}`, list: pinned.list };
}

/** Every binding's children, concatenated in binding order. */
export async function listUnion(
  repo: Repo,
  urls: AutomergeUrl[],
  providers?: ExtraProviders
): Promise<Child[]> {
  const lists = await Promise.all(
    urls.map(async (url) => {
      try {
        const doc = (await repo.find(url)).doc();
        return listOf(await providerOf(doc, providers), doc);
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
  handle: DocHandle<unknown>,
  providers?: ExtraProviders
): Promise<Child[]> {
  const doc = handle.doc();
  const provider = await providerOf(doc, providers);
  if (!provider) return [];
  const children = listOf(provider, doc);
  if (provider !== accountProvider) return children;

  const mounts = children.filter((child) => child.name !== "");
  const root = children.find((child) => child.name === "");
  const shadowed = new Set(mounts.map((child) => child.name));
  const rootChildren =
    root && "union" in root ? await listUnion(repo, root.union, providers) : [];
  return [
    ...rootChildren.filter((child) => !shadowed.has(child.name)),
    ...mounts,
  ];
}

export type FileContent = { content: string | Uint8Array; type: string };

/**
 * What a path names, read: its pinned form, whether the input was canonical, and the bytes.
 * With `heads`, the document the path ends at is read at those heads instead: how a file is
 * read at the heads its file list recorded, after it has changed.
 */
export async function readPath(
  repo: Repo,
  path: string,
  options: WalkOptions & { heads?: UrlHeads }
): Promise<(FileContent & { pinned: string; canonical: boolean }) | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end) return undefined;
  let node = end.node;
  if (options.heads) {
    const heads = options.heads;
    const find = options.find ?? ((url: AutomergeUrl) => repo.find(url));
    const holder = end.handle.documentId;
    try {
      if (end.atDocument) {
        const bare = stringifyAutomergeUrl({ documentId: holder });
        node = (await find(bare, heads)).view(heads).doc();
      } else {
        // A value inside a document: walk again with that document read at the heads.
        const atHeads = await walkPath(repo, path, {
          ...options,
          find: async (url, at) =>
            parseAutomergeUrl(url).documentId === holder
              ? (await find(url, heads)).view(heads)
              : find(url, at),
        });
        if (!atHeads) return undefined;
        node = atHeads.node;
      }
    } catch {
      return undefined;
    }
  }
  const read = await readNode(repo, node);
  return read && { ...read, pinned: end.pinned, canonical: end.canonical };
}

/**
 * A file under a pinned document, the document that holds its bytes, and the heads that
 * document was read at if it was reached by a link.
 */
export type ListedFile = FileContent & {
  tail: string;
  documentId: DocumentId;
  heads?: UrlHeads;
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
 * File docs are read with `findFile` (default: `find`), several at once. One that can't be read
 * is left out and its tail named in `missing`, so a caller can tell a partial list from a whole
 * one. A file reached by a link without heads is read as it is now, so the list is a snapshot.
 */
export async function listFiles(
  repo: Repo,
  path: string,
  options: WalkOptions & {
    findFile?: WalkOptions["find"];
    only?: string[];
    /** List into nested folders. Default: when the container has a `package.json`. */
    deep?: boolean;
  }
): Promise<{ prefix: string; files: ListedFile[]; missing: string[] } | undefined> {
  const end = await walkPath(repo, path, options);
  if (!end?.canonical || !end.container) return undefined;
  const find =
    options.findFile ?? options.find ?? ((url: AutomergeUrl) => repo.find(url));
  const root = end.container.handle.doc();
  const rootProvider = await providerOf(root, options.providers);
  const rootId = end.container.handle.documentId;
  // A package's relative imports reach into its nested folders by name, so a
  // package lists everything under it. Anything else lists its own files.
  const deep =
    options.deep ??
    listOf(rootProvider, root).some((child) => child.name === "package.json");

  const found = new Map<string, { keys: number[]; file: ListedFile }>();
  const missing: string[] = [];
  const tailOf = (parts: string[]) => parts.map(encodeURIComponent).join("/");
  const wanted = (parts: string[]) => !options.only || options.only.includes(tailOf(parts));
  // A folder is worth entering if anything wanted could be under it.
  const wantedBelow = (parts: string[]) =>
    !options.only || options.only.some((tail) => tail.startsWith(`${tailOf(parts)}/`));
  const add = async (
    parts: string[],
    keys: number[],
    node: unknown,
    holder: DocumentId,
    heads?: UrlHeads
  ) => {
    if (!wanted(parts)) return;
    const tail = tailOf(parts);
    const existing = found.get(tail);
    if (existing && !walkPrefers(keys, existing.keys)) return;
    const read = await readNode(repo, node);
    if (read) {
      found.set(tail, {
        keys,
        file: { ...read, tail, documentId: holder, ...(heads ? { heads } : {}) },
      });
    }
  };

  // Values are read in place; links are gathered and read below.
  type Link = { parts: string[]; keys: number[]; link: AutomergeUrl };
  const entered = new Set<string>([rootId]);
  // `heads`: what the holder was read at, when it's a doc below the container (reached by a
  // link, so not pinned by the container's step): its values are read back at those heads.
  const visit = async (
    node: unknown,
    provider: PathProvider | undefined,
    holder: DocumentId,
    parts: string[],
    keys: number[],
    heads?: UrlHeads
  ): Promise<Link[]> => {
    const links: Link[] = [];
    for (const child of listOf(provider, node)) {
      const names = nameSegments(provider, child.name);
      const childParts = [...parts, ...names];
      const childKeys = [...keys, names.length];
      const builtIn = provider === directoryProvider || provider === folderProvider;
      if ("sub" in child || "value" in child) {
        const value = "sub" in child ? valueAt(node, child.sub) : child.value;
        if (value === undefined) continue;
        await add(childParts, childKeys, value, holder, heads);
        // A package's provider walks on into the values it hands out, so list what's in them.
        if (!builtIn && value && typeof value === "object" && !(value instanceof Uint8Array)) {
          links.push(...(await visit(value, provider, holder, childParts, childKeys, heads)));
          continue;
        }
      }
      if ("value" in child) {
        // Nested values are addressable by path only inside a directory doc.
        if (provider === directoryProvider && isNested(child.value)) {
          links.push(...(await visit(child.value, provider, holder, childParts, childKeys, heads)));
        }
      } else if (
        "link" in child &&
        (wanted(childParts) || (deep && wantedBelow(childParts)))
      ) {
        links.push({ parts: childParts, keys: childKeys, link: child.link });
      }
    }
    return links;
  };

  // At most LIST_CONCURRENCY file docs read at once, nested folders included.
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (active >= LIST_CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
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
      // A link to a sub-document isn't a file a walk can reach (see walkPath).
      if (parsed.segments?.length) return;
      const live = await find(
        stringifyAutomergeUrl({ documentId: parsed.documentId }),
        parsed.heads
      );
      const heads = parsed.heads ?? live.heads();
      const doc = live.view(heads).doc();
      if (doc === undefined) return;
      // Built-ins decide what's a file, as the walk does for a path that ends here.
      const provider = providerFor(doc);
      if (!provider) {
        await add(parts, keys, doc, parsed.documentId, heads);
      } else if (
        deep &&
        (provider === folderProvider || provider === directoryProvider) &&
        !entered.has(parsed.documentId)
      ) {
        // Into a nested folder, by name: its files are under its name here.
        entered.add(parsed.documentId);
        await add(parts, keys, doc, parsed.documentId, heads);
        below = await visit(doc, provider, parsed.documentId, parts, keys, heads);
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
