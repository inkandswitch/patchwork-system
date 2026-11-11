// Document scripts. A `.tldraw` archive can carry a `script/**` tree whose
// `main.js` default-exports a function that runs against the live editor once
// the canvas mounts (and whose siblings it may import). On import each file
// becomes its own Patchwork `file` document, so the script is editable in
// Patchwork like any other file.
//
// Running one means turning those documents back into modules. There is no
// importmap on this page for `tldraw`, and relative specifiers point at
// documents rather than paths, so each file is rewritten and handed to the
// browser as a blob module.

import type { DocHandle, Repo } from "@automerge/automerge-repo/slim";
import type {
  DocLink,
  FolderDoc,
  UnixFileEntry,
} from "@inkandswitch/patchwork-filesystem";
import type { Editor } from "@tldraw/tldraw";
import * as tldrawSdk from "@tldraw/tldraw";
import * as reactSdk from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as reactDomSdk from "react-dom";
import * as reactDomClient from "react-dom/client";

import type { ZipEntries } from "./zip.ts";
import { makeScriptHelpers, type ScriptHelpers } from "./script-helpers.ts";

// What a `main.js` default export receives, mirroring the desktop app's
// `MainScriptContext`. `app` is deliberately absent — it is host-provided and
// feature-detected (`ctx.app?.window`), and there is no desktop window here.
export type MainScriptContext = {
  editor: Editor;
  helpers: ScriptHelpers;
  signal: AbortSignal;
};

const SCRIPT_PREFIX = "script/";
const ENTRY = "main.js";
const CONFIG = "config.js";

const TEXT_EXTENSIONS = new Set(["js", "mjs", "json", "css", "ts", "txt", "md"]);

function extensionOf(path: string) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function mimeTypeOf(path: string) {
  switch (extensionOf(path)) {
    case "js":
    case "mjs":
      return "text/javascript";
    case "json":
      return "application/json";
    case "css":
      return "text/css";
    case "wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

/** The `script/**` entries of an archive, keyed by path relative to `script/`. */
export function extractScriptFiles(files: ZipEntries): Map<string, Uint8Array> {
  const script = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    if (!name.startsWith(SCRIPT_PREFIX) || name.endsWith("/")) continue;
    script.set(name.slice(SCRIPT_PREFIX.length), bytes);
  }
  return script;
}

async function createFileDoc(repo: Repo, path: string, bytes: Uint8Array) {
  const extension = extensionOf(path);
  const handle = await repo.create2<UnixFileEntry>({
    "@patchwork": { type: "file" },
    content: TEXT_EXTENSIONS.has(extension)
      ? new TextDecoder().decode(bytes)
      : bytes,
    extension,
    mimeType: mimeTypeOf(path),
    name: path.slice(path.lastIndexOf("/") + 1),
  } as UnixFileEntry);
  return handle.url;
}

/**
 * Stores a `script/**` tree as `DocLink[]` — a file document per file, a nested
 * folder document per directory. The result goes straight onto the canvas
 * document's `docs`, which is why a canvas is FolderDoc-compatible.
 */
export async function storeScriptFiles(
  repo: Repo,
  files: Map<string, Uint8Array>
): Promise<DocLink[]> {
  const here: Array<[string, Uint8Array]> = [];
  const directories = new Map<string, Map<string, Uint8Array>>();

  for (const [path, bytes] of files) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      here.push([path, bytes]);
      continue;
    }
    const directory = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    const nested = directories.get(directory) ?? new Map();
    nested.set(rest, bytes);
    directories.set(directory, nested);
  }

  const links: DocLink[] = [];
  for (const [name, bytes] of here) {
    links.push({
      name,
      type: "file",
      url: (await createFileDoc(repo, name, bytes)) as DocLink["url"],
    });
  }
  for (const [name, nested] of directories) {
    const handle = await repo.create2<FolderDoc>({
      "@patchwork": { type: "folder" },
      title: name,
      docs: await storeScriptFiles(repo, nested),
    } as FolderDoc);
    links.push({ name, type: "folder", url: handle.url });
  }

  return links;
}

/** Flattens the `DocLink[]` tree back into archive-relative path → doc url. */
export async function resolveScriptFiles(
  repo: Repo,
  docs: DocLink[] | undefined,
  prefix = ""
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const link of docs ?? []) {
    const path = prefix ? `${prefix}/${link.name}` : link.name;
    if (link.type === "folder") {
      const handle = await repo.find<FolderDoc>(link.url);
      Object.assign(
        files,
        await resolveScriptFiles(repo, handle.doc()?.docs, path)
      );
    } else {
      files[path] = link.url;
    }
  }
  return files;
}

/**
 * The script tree as the runner needs it: where each file lives, a version that
 * moves whenever a file is edited, and every document involved so the tree can
 * be watched.
 */
export type ScriptTree = {
  /** archive-relative path → file document url */
  files: Record<string, string>;
  /** archive-relative path → version, changing on every edit to that file */
  versions: Record<string, string>;
  /** every document in the tree, the folders included */
  handles: DocHandle<unknown>[];
};

export async function readScriptTree(
  repo: Repo,
  docs: DocLink[] | undefined,
  prefix = ""
): Promise<ScriptTree> {
  const tree: ScriptTree = { files: {}, versions: {}, handles: [] };
  for (const link of docs ?? []) {
    const path = prefix ? `${prefix}/${link.name}` : link.name;
    const handle = await repo.find<FolderDoc>(link.url);
    tree.handles.push(handle as unknown as DocHandle<unknown>);
    if (link.type === "folder") {
      const nested = await readScriptTree(repo, handle.doc()?.docs, path);
      Object.assign(tree.files, nested.files);
      Object.assign(tree.versions, nested.versions);
      tree.handles.push(...nested.handles);
    } else {
      tree.files[path] = link.url;
      tree.versions[path] = handle.heads().join(",");
    }
  }
  return tree;
}

/**
 * Reads the tree and reads it again whenever any of its documents changes, so
 * editing a script file in Patchwork takes effect on the canvas immediately.
 * Reads are serialised: a burst of edits can't leave two readers racing to
 * attach listeners to the same handles.
 */
export function watchScriptTree(
  repo: Repo,
  docs: DocLink[] | undefined,
  onTree: (tree: ScriptTree) => void
): () => void {
  const watched = new Map<string, DocHandle<unknown>>();
  let stopped = false;
  let reading: Promise<void> = Promise.resolve();

  const reread = () => {
    reading = reading.then(async () => {
      if (stopped) return;
      const tree = await readScriptTree(repo, docs);
      if (stopped) return;
      const next = new Map<string, DocHandle<unknown>>(
        tree.handles.map((handle) => [handle.url, handle])
      );
      for (const [url, handle] of watched) {
        if (next.has(url)) continue;
        handle.off("change", reread);
        watched.delete(url);
      }
      for (const [url, handle] of next) {
        if (watched.has(url)) continue;
        handle.on("change", reread);
        watched.set(url, handle);
      }
      onTree(tree);
    });
  };

  reread();

  return () => {
    stopped = true;
    for (const handle of watched.values()) handle.off("change", reread);
    watched.clear();
  };
}

/** The part of a tree's state a script actually depends on. */
export function signatureOf(deps: string[], versions: Record<string, string>) {
  return deps.map((path) => `${path}@${versions[path] ?? ""}`).join("|");
}

/** Reads the linked documents back out as archive bytes, keyed by path. */
export async function readScriptFiles(
  repo: Repo,
  docs: DocLink[] | undefined
): Promise<Map<string, Uint8Array>> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  for (const [path, url] of Object.entries(
    await resolveScriptFiles(repo, docs)
  )) {
    const handle = await repo.find<UnixFileEntry>(url as never);
    const content = handle.doc()?.content;
    if (content == null) continue;
    files.set(
      path,
      typeof content === "string"
        ? encoder.encode(content)
        : new Uint8Array(content as Uint8Array)
    );
  }
  return files;
}

export function hasScript(files: Record<string, string>) {
  return ENTRY in files;
}

function resolvePath(from: string, specifier: string) {
  const base = from.slice(0, from.lastIndexOf("/") + 1);
  const parts = (base + specifier).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

// Bare specifiers a script may import. There is no importmap on this page, so
// each is served as a generated module re-exporting the copy this tool already
// bundles — the script gets the same instances the canvas is running on rather
// than a second copy of React or the SDK.
const BUNDLED: Record<string, Record<string, unknown>> = {
  tldraw: tldrawSdk,
  "@tldraw/tldraw": tldrawSdk,
  react: reactSdk,
  "react/jsx-runtime": reactJsxRuntime,
  "react-dom": reactDomSdk,
  "react-dom/client": reactDomClient,
};

// A namespace built from CommonJS carries a `default` key, and `export const
// default = …` is a syntax error.
const NOT_EXPORTABLE = new Set(["default", "class", "function", "import", "new"]);

function shimUrl(
  specifier: string,
  shims: Map<string, string>,
  revoke: string[]
) {
  const cached = shims.get(specifier);
  if (cached) return cached;

  const namespace = BUNDLED[specifier];
  const key = `__tldraw5_shim_${specifier.replace(/\W/g, "_")}`;
  (globalThis as Record<string, unknown>)[key] = namespace;

  const names = Object.keys(namespace).filter(
    (name) => /^[A-Za-z_$][\w$]*$/.test(name) && !NOT_EXPORTABLE.has(name)
  );
  const source = [
    `const m = globalThis[${JSON.stringify(key)}];`,
    `export default m.default ?? m;`,
    ...names.map((name) => `export const ${name} = m[${JSON.stringify(name)}];`),
  ].join("\n");

  const url = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  revoke.push(url);
  shims.set(specifier, url);
  return url;
}

// `from '…'` / `import('…')` specifiers only — a bare word match would rewrite
// unrelated strings inside a bundled vendor file.
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;

/**
 * Builds a blob module for `path`, recursively building whatever it imports.
 * Cycles are not supported — a script that imports itself in a loop will throw.
 */
async function buildModule(
  repo: Repo,
  files: Record<string, string>,
  path: string,
  built: Map<string, string>,
  shims: Map<string, string>,
  revoke: string[]
): Promise<string> {
  const existing = built.get(path);
  if (existing) return existing;

  const url = files[path];
  if (!url) throw new Error(`script file not found: ${path}`);

  const handle = await repo.find<UnixFileEntry>(url as never);
  const content = handle.doc()?.content;
  const source =
    typeof content === "string"
      ? content
      : new TextDecoder().decode(content as Uint8Array);

  const specifiers = new Map<string, string>();
  for (const [, , , specifier] of source.matchAll(SPECIFIER)) {
    if (specifiers.has(specifier)) continue;
    if (specifier in BUNDLED) {
      specifiers.set(specifier, shimUrl(specifier, shims, revoke));
    } else if (specifier.startsWith(".")) {
      const target = resolvePath(path, specifier);
      const targetUrl = files[target];
      if (!targetUrl) continue;
      const cached = built.get(target);
      if (cached) {
        specifiers.set(specifier, cached);
        continue;
      }
      // Non-JS siblings (wasm, json) are fetched by the script rather than
      // imported, so they become plain blob urls.
      const isModule =
        TEXT_EXTENSIONS.has(extensionOf(target)) &&
        extensionOf(target) !== "json";
      const targetBlob = isModule
        ? await buildModule(repo, files, target, built, shims, revoke)
        : await blobUrlFor(repo, targetUrl, target, revoke);
      built.set(target, targetBlob);
      specifiers.set(specifier, targetBlob);
    }
  }

  const rewritten = source.replace(
    SPECIFIER,
    (match, keyword: string, quote: string, specifier: string) => {
      const replacement = specifiers.get(specifier);
      return replacement ? `${keyword}${quote}${replacement}${quote}` : match;
    }
  );

  const blobUrl = URL.createObjectURL(
    new Blob([rewritten], { type: "text/javascript" })
  );
  revoke.push(blobUrl);
  built.set(path, blobUrl);
  return blobUrl;
}

async function blobUrlFor(
  repo: Repo,
  url: string,
  path: string,
  revoke: string[]
) {
  const handle = await repo.find<UnixFileEntry>(url as never);
  const content = handle.doc()?.content;
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const blobUrl = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mimeTypeOf(path) })
  );
  revoke.push(blobUrl);
  return blobUrl;
}

// The shape of the object a `config.js` receives and returns. Mirrors the
// desktop app's `TldrawConfig`: arrays of constructors the script pushes onto,
// a components map it overwrites slots in, and the editor options.
export type TldrawConfig = {
  shapeUtils: unknown[];
  bindingUtils: unknown[];
  assetUtils: unknown[];
  overlayUtils: unknown[];
  tools: unknown[];
  components: Record<string, unknown>;
  options: Record<string, unknown>;
  getShapeVisibility?: unknown;
  assetUrls?: unknown;
  initialState?: string;
};

/**
 * Runs `config.js` before the editor mounts, giving it the config the canvas is
 * about to be built from. Built as its own module graph — `config.js` and
 * `main.js` don't share instances of the files they both import, matching the
 * desktop app.
 */
export async function runConfigScript(
  repo: Repo,
  files: Record<string, string>,
  config: TldrawConfig
): Promise<{ config: TldrawConfig; dispose: () => void; deps: string[] }> {
  const dispose = (urls: string[]) => () => {
    for (const url of urls) URL.revokeObjectURL(url);
  };

  if (!(CONFIG in files)) return { config, dispose: dispose([]), deps: [] };

  const revoke: string[] = [];
  const shims = new Map<string, string>();
  const built = new Map<string, string>();

  try {
    const url = await buildModule(repo, files, CONFIG, built, shims, revoke);
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: (ctx: { config: TldrawConfig }) => TldrawConfig | Promise<TldrawConfig>;
    };
    const result = (await module.default?.({ config })) ?? config;
    return { config: result, dispose: dispose(revoke), deps: [...built.keys()] };
  } catch (error) {
    dispose(revoke)();
    throw error;
  }
}

/**
 * Runs a document's script against the editor. Returns the files it was built
 * from — so a caller can re-run it when one of them is edited — and a cleanup
 * that aborts the script's signal and revokes the blob urls.
 */
export async function runScript(
  repo: Repo,
  files: Record<string, string>,
  editor: Editor
): Promise<{ dispose: () => void; deps: string[] }> {
  const revoke: string[] = [];
  const shims = new Map<string, string>();
  const built = new Map<string, string>();
  const aborter = new AbortController();

  try {
    const entryUrl = await buildModule(
      repo,
      files,
      ENTRY,
      built,
      shims,
      revoke
    );
    const module = (await import(/* @vite-ignore */ entryUrl)) as {
      default?: (ctx: MainScriptContext) => unknown;
    };
    // `signal` is the script's teardown hook — it aborts when the canvas
    // unmounts, the same point at which the desktop app aborts it.
    await module.default?.({
      editor,
      helpers: makeScriptHelpers(editor),
      signal: aborter.signal,
    });
  } catch (error) {
    aborter.abort();
    for (const url of revoke) URL.revokeObjectURL(url);
    throw error;
  }

  return {
    deps: [...built.keys()],
    dispose: () => {
      aborter.abort();
      for (const url of revoke) URL.revokeObjectURL(url);
    },
  };
}
