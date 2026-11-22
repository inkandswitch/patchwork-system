import {
  type AutomergeUrl,
  isImmutableString,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { type HasPatchworkMetadata, getType } from "./metadata.js";
import type { FolderDoc } from "./types.js";

/**
 * What a provider finds under a name: a link to another document, or a value inside the same
 * document (a nested directory, a file's bytes).
 */
export type Child =
  | { name: string; link: AutomergeUrl }
  | { name: string; value: unknown };

/** A child and how many of the leading names it used. */
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

const isObject = (node: unknown): node is Record<string, unknown> =>
  !!node &&
  typeof node === "object" &&
  !Array.isArray(node) &&
  !(node instanceof Uint8Array) &&
  !isImmutableString(node);

function childOf(name: string, value: unknown): Child {
  const link = asLink(value);
  return link ? { name, link } : { name, value };
}

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
    const entry = (node as FolderDoc).docs.find(
      (doc) => doc && String(doc.name) === names[0]
    );
    const link = asLink(entry?.url);
    return link ? { child: { name: names[0], link }, consumed: 1 } : undefined;
  },
  list(node) {
    return (node as FolderDoc).docs.flatMap((doc) => {
      const link = asLink(doc?.url);
      return link ? [{ name: String(doc.name), link }] : [];
    });
  },
};

/** Checked in order; the first that matches a document walks it. */
export const PROVIDERS: readonly PathProvider[] = [
  directoryProvider,
  folderProvider,
];

export function providerFor(doc: unknown): PathProvider | undefined {
  return PROVIDERS.find((provider) => provider.matches(doc));
}
