import {
  type AutomergeUrl,
  isImmutableString,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { type HasPatchworkMetadata, getType } from "./metadata.js";
import type { AccountNamespaceDoc, FolderDoc } from "./types.js";

/**
 * What a provider finds under a name: a link to another document, a value inside the same
 * document (a nested directory, a file's bytes), or an ordered union of documents (a mount).
 */
export type Child =
  | { name: string; link: AutomergeUrl }
  | { name: string; value: unknown }
  | { name: string; union: AutomergeUrl[] };

/**
 * A child and how many of the leading names it used. A step that consumes no name (the `/`
 * mount) has `consumed: 0`.
 */
export type Lookup = { child: Child; consumed: number };

/**
 * How to walk one kind of document. `lookup` and `list` take the document or a value nested in
 * it, and never leave it: following a link is the walker's job. `lookup` is called with at least
 * one name. They read only the node they're given, so a walk at the same heads gives the same
 * answer.
 */
export interface PathProvider {
  readonly kind: string;
  matches(doc: unknown): boolean;
  lookup(node: unknown, names: string[]): Lookup | undefined;
  list(node: unknown): Child[];
}

/**
 * `value` as a link, if it is one. A link written as an `ImmutableString`
 * (one op, where a plain string is an op per character) reads back as an
 * object, not a string; it's the same url.
 */
export function asLink(value: unknown): AutomergeUrl | undefined {
  const url = isImmutableString(value) ? String(value) : value;
  return typeof url === "string" && isValidAutomergeUrl(url) ? url : undefined;
}

// A map or a list: a list's children are named by index.
const isObject = (node: unknown): node is Record<string, unknown> =>
  !!node &&
  typeof node === "object" &&
  !(node instanceof Uint8Array) &&
  !isImmutableString(node);

function childOf(name: string, value: unknown): Child {
  const link = asLink(value);
  return link ? { name, link } : { name, value };
}

const MOUNT_POINT = /^\/[^/@]*$/;

// The same malformed mount is read on every lookup, so say so once.
const warned = new Set<string>();
const warnOnce = (key: string, message: string) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
};

// Bindings are read on every lookup and list, from a doc that doesn't change under them.
const bindingsByDoc = new WeakMap<object, Map<string, AutomergeUrl[]>>();

/**
 * Mount point → its bindings, in order. `/` falls back to `rootFolderUrl` when the namespace
 * binds nothing valid there, so accounts without a namespace keep working. Malformed mount
 * points and bindings are skipped with a warning.
 */
export function accountBindings(
  doc: AccountNamespaceDoc
): Map<string, AutomergeUrl[]> {
  const memo = bindingsByDoc.get(doc);
  if (memo) return memo;
  const bindings = new Map<string, AutomergeUrl[]>();
  const namespace = isObject(doc.namespace) ? doc.namespace : {};
  for (const [mount, list] of Object.entries(namespace)) {
    if (!MOUNT_POINT.test(mount) || !Array.isArray(list)) {
      warnOnce(mount, `namespace: skipping malformed mount ${JSON.stringify(mount)}`);
      continue;
    }
    const urls: AutomergeUrl[] = [];
    for (const binding of list) {
      const url = asLink(binding?.url);
      if (url) urls.push(url);
      else
        warnOnce(
          `binding ${mount}`,
          `namespace: skipping a binding at ${mount} without a valid url`
        );
    }
    bindings.set(mount, urls);
  }
  const root = asLink(doc.rootFolderUrl);
  if (!bindings.get("/")?.length && root) bindings.set("/", [root]);
  bindingsByDoc.set(doc, bindings);
  return bindings;
}

/**
 * An account is walked through its mount table. A first name that is a mount point goes to that
 * mount; any other name goes to `/` without being used up, so `/Projects/x` reads the root
 * folder and `/packages/x` reads whatever is bound at `/packages`.
 */
export const accountProvider: PathProvider = {
  kind: "account",
  matches(doc) {
    return (
      !!doc &&
      typeof doc === "object" &&
      getType(doc as Partial<HasPatchworkMetadata>) === "account"
    );
  },
  lookup(node, names) {
    if (!accountProvider.matches(node)) return undefined;
    const bindings = accountBindings(node as AccountNamespaceDoc);
    const mount = bindings.get(`/${names[0]}`);
    if (names[0] && mount) {
      return { child: { name: names[0], union: mount }, consumed: 1 };
    }
    const root = bindings.get("/");
    if (!root?.length) return undefined;
    return { child: { name: "", union: root }, consumed: 0 };
  },
  list(node) {
    if (!accountProvider.matches(node)) return [];
    const children: Child[] = [];
    for (const [mount, union] of accountBindings(node as AccountNamespaceDoc)) {
      const child = { name: mount.slice(1), union };
      if (mount === "/") children.unshift(child);
      else children.push(child);
    }
    return children;
  },
};

export const directoryProvider: PathProvider = {
  kind: "directory",
  matches(doc) {
    return (
      !!doc &&
      typeof doc === "object" &&
      getType(doc as Partial<HasPatchworkMetadata>) === "directory"
    );
  },
  // Longest-prefix match: try "main/dist/index.js", then "main/dist", then "main"
  lookup(node, names) {
    if (!isObject(node)) return undefined;
    for (let i = names.length; i >= 1; i--) {
      const key = names.slice(0, i).join("/");
      if (Object.hasOwn(node, key)) {
        return { child: childOf(key, node[key]), consumed: i };
      }
    }
    return undefined;
  },
  list(node) {
    if (!isObject(node)) return [];
    return Object.entries(node)
      .filter(([key]) => key !== "@patchwork")
      .map(([key, value]) => childOf(key, value));
  },
};

export const folderProvider: PathProvider = {
  kind: "folder",
  matches(doc) {
    return (
      !!doc &&
      typeof doc === "object" &&
      "docs" in doc &&
      Array.isArray((doc as { docs: unknown }).docs)
    );
  },
  lookup(node, names) {
    if (!folderProvider.matches(node)) return undefined;
    const entry = (node as FolderDoc).docs.find(
      (doc) => doc && String(doc.name) === names[0]
    );
    const link = asLink(entry?.url);
    return link ? { child: { name: names[0], link }, consumed: 1 } : undefined;
  },
  list(node) {
    if (!folderProvider.matches(node)) return [];
    return (node as FolderDoc).docs.flatMap((doc) => {
      const link = asLink(doc?.url);
      return link ? [{ name: String(doc.name), link }] : [];
    });
  },
};

/** Checked in order; the first that matches a document walks it. */
export const PROVIDERS: readonly PathProvider[] = [
  accountProvider,
  directoryProvider,
  folderProvider,
];

export function providerFor(doc: unknown): PathProvider | undefined {
  return PROVIDERS.find((provider) => provider.matches(doc));
}
