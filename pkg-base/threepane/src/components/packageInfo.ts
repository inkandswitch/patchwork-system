// What we can learn about a package a doc suggests, before anyone loads it.
//
// Two kinds of thing, kept apart because they deserve different trust:
//
//   • what the package says about itself: its package.json (fetched, never
//     run), and, only when asked, the plugins it reports when its entry module
//     is imported in the host's module-loader worker. Either can say anything.
//   • what we can see for ourselves: the automerge URL, its heads, and who has
//     written to the package's folder doc, read from our own repo.
//
// The package.json reading and the worker protocol are copied from the
// packages tool (packages/src/pkg-meta.ts, packages/src/discover-plugins.ts),
// minus its main-thread import paths: here nothing a doc suggests runs on the
// page before it's loaded for real.

import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import * as Automerge from "@automerge/automerge/slim";
import { getImportableUrlFromAutomergeUrl } from "@inkandswitch/patchwork-filesystem";

export const isAutomergeUrl = (url: string): boolean =>
  url.startsWith("automerge:");

/** The url without any `#heads` pin or `?query`. */
export function bareAutomergeUrl(url: string): AutomergeUrl {
  return url.replace(/[#?].*$/, "") as AutomergeUrl;
}

/** The heads an automerge url is pinned to, if it is (`automerge:<id>#a|b`). */
export function pinnedHeads(url: string): string[] {
  const hash = url.split("#")[1];
  return hash ? hash.split("|").filter(Boolean) : [];
}

// ── what it says ────────────────────────────────────────────────────────────

export interface PluginClaim {
  id?: string;
  name?: string;
  type?: string;
  supportedDatatypes?: string[];
}

export interface PackageClaims {
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  author?: string;
  /** the plugins its package.json lists, if it lists any */
  plugins?: PluginClaim[];
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function author(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object") {
    const { name, email } = value as { name?: unknown; email?: unknown };
    const n = text(name);
    const e = text(email);
    return n && e ? `${n} <${e}>` : (n ?? e);
  }
  return undefined;
}

function pluginClaim(plugin: unknown): PluginClaim {
  if (!plugin || typeof plugin !== "object") return {};
  const p = plugin as Record<string, unknown>;
  const datatypes = p.supportedDatatypes;
  return {
    id: text(p.id),
    name: text(p.name),
    type: text(p.type),
    supportedDatatypes:
      typeof datatypes === "string"
        ? [datatypes]
        : Array.isArray(datatypes)
          ? datatypes.filter((d): d is string => typeof d === "string")
          : undefined,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

// build output dirs to look past for an http package's package.json
const BUILD_DIRS = new Set(["dist", "build", "lib", "out", "esm", "src", "public"]);

async function packageJson(url: string): Promise<unknown> {
  if (isAutomergeUrl(url)) {
    // the service worker serves the folder doc's files; fetching one runs nothing
    const base = getImportableUrlFromAutomergeUrl(url as AutomergeUrl);
    return fetchJson(new URL("package.json", base).href);
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const dirs = u.pathname.split("/").filter(Boolean);
  if (/\.[a-z0-9]+$/i.test(dirs.at(-1) ?? "")) dirs.pop();
  for (;;) {
    const base = `${u.origin}/${dirs.join("/")}${dirs.length ? "/" : ""}`;
    const pkg = await fetchJson(new URL("package.json", base).href);
    if (pkg && typeof pkg === "object") return pkg;
    if (!BUILD_DIRS.has(dirs.at(-1)?.toLowerCase() ?? "")) return undefined;
    dirs.pop();
  }
}

/** What the package's package.json says, read without running anything. */
export async function readClaims(url: string): Promise<PackageClaims | undefined> {
  const pkg = (await packageJson(url)) as Record<string, unknown> | undefined;
  if (!pkg) return undefined;
  return {
    name: text(pkg.name),
    title: text(pkg.title),
    version: text(pkg.version),
    description: text(pkg.description),
    author: author(pkg.author),
    plugins: Array.isArray(pkg.plugins) ? pkg.plugins.map(pluginClaim) : undefined,
  };
}

// the host's module-loader worker (the bootloader emits it), shared by every
// card that asks. it imports the package's entry module and reports back the
// plugins it exports, as plain descriptions
type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: unknown[] }
  | { type: "error"; id: number; error: string };

let worker: Worker | undefined;
let nextRequest = 1;
const waiting = new Map<
  number,
  { resolve: (plugins: PluginClaim[]) => void; reject: (error: Error) => void }
>();

function moduleLoader(): Worker {
  if (worker) return worker;
  const w = new Worker("/module-loader-worker.js", {
    type: "module",
    name: "threepane-package-preview",
  });
  w.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const entry = reply && waiting.get(reply.id);
    if (!entry) return;
    waiting.delete(reply.id);
    if (reply.type === "descriptors")
      entry.resolve(reply.descriptors.map(pluginClaim));
    else entry.reject(new Error(reply.error));
  });
  w.addEventListener("error", (event) => {
    // not tied to any one request: fail them all, and start afresh next time
    const error = new Error(`the background worker stopped: ${event.message ?? "no reason given"}`);
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
    worker = undefined;
  });
  worker = w;
  return w;
}

/**
 * Ask the package what plugins it brings, by importing it in the host's
 * module-loader worker. This RUNS the package's entry module (off the page,
 * but with the site's storage and network), so only call it once the reader
 * has said yes. Automerge packages only: there's no worker that imports http.
 */
export function askPlugins(url: string, timeoutMs = 15000): Promise<PluginClaim[]> {
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiting.delete(id)) reject(new Error("it took too long to answer"));
    }, timeoutMs);
    waiting.set(id, {
      resolve: (plugins) => {
        clearTimeout(timer);
        resolve(plugins);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      moduleLoader().postMessage({ type: "discover", id, url });
    } catch (error) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ── what we can see ─────────────────────────────────────────────────────────

export interface Writer {
  actor: string;
  changes: number;
  /** seconds since the epoch, as automerge keeps them (0 when unrecorded) */
  first: number;
  last: number;
}

export interface PackageHistory {
  heads: string[];
  changes: number;
  /** most changes first */
  writers: Writer[];
}

/**
 * The folder doc's current heads, and which actors have written to it. Only
 * the folder doc itself: each file in the package is a doc of its own, with
 * its own history. Rejects when the repo can't get the folder.
 */
export async function readHistory(repo: Repo, url: string): Promise<PackageHistory> {
  const handle = await repo.find(bareAutomergeUrl(url));
  const doc = handle.doc();
  // give the page a moment before walking what may be a long history
  await new Promise((resolve) => setTimeout(resolve, 0));
  const metas = Automerge.getChangesMetaSince(doc, []);
  const byActor = new Map<string, Writer>();
  for (const meta of metas) {
    const time = meta.time ?? 0;
    const writer = byActor.get(meta.actor);
    if (!writer) {
      byActor.set(meta.actor, { actor: meta.actor, changes: 1, first: time, last: time });
      continue;
    }
    writer.changes++;
    if (time && (!writer.first || time < writer.first)) writer.first = time;
    if (time > writer.last) writer.last = time;
  }
  return {
    heads: [...handle.heads()],
    changes: metas.length,
    writers: [...byActor.values()].sort((a, b) => b.changes - a.changes),
  };
}
