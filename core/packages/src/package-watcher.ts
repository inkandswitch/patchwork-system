import {
  type AutomergeUrl,
  type DocHandle,
  isValidAutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import debug from "debug";
import { readPackageManifest } from "./manifest.js";
import type { PackageListDoc, PatchworkPackage } from "./types.js";

const log = debug("patchwork:packages");

// A sync commits a burst of changes to a folder doc, so wait for its heads to
// stop moving before re-reading the manifest at a settled snapshot.
const RELOAD_DEBOUNCE_MS = 250;

// A manifest fetch can fail only because the automerge worker serving the
// package's files is still coming up. Nothing else brings it back.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

export type PackageWatcherOptions = {
  sources?: Record<string, string>;
  onPackage: (pkg: PatchworkPackage) => void;
  onRemove?: (url: string) => void;
  /**
   * Called for a package with no `patchwork.json`. Pass `readLegacyPackage`
   * from ./legacy-adapter.js to keep pre-manifest packages working; without it
   * such a package is skipped.
   */
  readLegacyPackage?: (url: string) => Promise<PatchworkPackage | undefined>;
};

function documentBaseUrl(): string {
  return (
    globalThis.document?.baseURI ??
    globalThis.location?.href ??
    "http://localhost/"
  );
}

function listedUrls(doc: PackageListDoc | undefined): string[] {
  const modules = Array.isArray(doc?.modules) ? doc.modules : [];
  const packages = doc?.packages ? Object.values(doc.packages) : [];
  return [...modules, ...packages].filter((url) => typeof url === "string");
}

async function fetchPackageList(url: string): Promise<string[]> {
  const listUrl = new URL(url, documentBaseUrl()).href;
  const response = await fetch(listUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch package list ${listUrl}: ${response.status}`
    );
  }
  const json = (await response.json()) as PackageListDoc;
  return listedUrls(json).map((packageUrl) =>
    isValidAutomergeUrl(packageUrl)
      ? packageUrl
      : new URL(packageUrl, listUrl).href
  );
}

/**
 * Watches the packages listed by one or more settings sources and announces
 * the contents of each package's `patchwork.json`. Nothing is imported: a
 * manifest is data, and a plugin's `import` is a URL for whoever activates it.
 *
 * A source URL is either an Automerge settings doc (live-reloaded) or an
 * HTTP(S) JSON list of the same shape (fetched once); either lists its
 * packages under `modules`, under `packages`, or both. The packages themselves
 * can be Automerge folder docs or HTTP(S) package roots.
 */
export class PackageWatcher {
  repo: Repo;
  sources: Record<string, string>;
  doneLoading: Promise<void>;

  #onPackage: (pkg: PatchworkPackage) => void;
  #onRemove?: (url: string) => void;
  #readLegacyPackage?: (url: string) => Promise<PatchworkPackage | undefined>;
  #settingsHandles = new Map<string, DocHandle<PackageListDoc>>();
  #staticLists = new Map<string, string[]>();
  #watched = new Map<string, () => void>();
  // Bumped whenever a newer announce starts for the same package, so a stale
  // retry chain abandons itself instead of announcing an older version last.
  #generations = new Map<string, number>();
  #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #announced = new Map<string, string>();
  #active = new Set<string>();
  #disposed = false;

  constructor(repo: Repo, options: PackageWatcherOptions) {
    this.repo = repo;
    this.sources = { ...options.sources };
    this.#onPackage = options.onPackage;
    this.#onRemove = options.onRemove;
    this.#readLegacyPackage = options.readLegacyPackage;
    this.doneLoading = this.#init();
  }

  #onSettingsChange = () => this.#load().catch(console.error);

  async #init(): Promise<void> {
    const entries = Object.entries(this.sources);
    const settled = await Promise.allSettled(
      entries.map(([name, url]) => this.#openSource(name, url))
    );
    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") {
        const [name, url] = entries[index];
        console.warn(
          `package source "${name}" (${url}) failed to load; skipping`,
          result.reason
        );
      }
    }
    if (this.#disposed) return;
    await this.#load();
  }

  async #openSource(name: string, url: string): Promise<void> {
    if (isValidAutomergeUrl(url)) {
      const handle = await this.repo.find<PackageListDoc>(url);
      this.#staticLists.delete(name);
      this.#settingsHandles.set(name, handle);
      if (!this.#disposed) handle.addListener("change", this.#onSettingsChange);
      return;
    }
    const list = await fetchPackageList(url);
    this.#settingsHandles.delete(name);
    this.#staticLists.set(name, list);
  }

  async addSource(name: string, url: string): Promise<void> {
    if (this.sources[name] === url) return;
    this.sources[name] = url;
    await this.doneLoading;
    if (this.#disposed) return;
    this.#settingsHandles
      .get(name)
      ?.removeListener("change", this.#onSettingsChange);
    await this.#openSource(name, url);
    await this.#load();
  }

  async #load(): Promise<void> {
    const urls = new Set<string>();
    for (const handle of this.#settingsHandles.values()) {
      for (const url of listedUrls(handle.doc())) urls.add(url);
    }
    for (const list of this.#staticLists.values()) {
      for (const url of list) urls.add(url);
    }

    const previous = this.#active;
    this.#active = urls;
    for (const url of previous) if (!urls.has(url)) this.#unload(url);

    await Promise.all(
      [...urls].map(async (url) => {
        try {
          await this.#watch(url);
        } catch (error) {
          console.error(
            new Error(`Failed to read package ${url}: ${error}`, {
              cause: error,
            })
          );
        }
      })
    );
  }

  async #watch(url: string): Promise<void> {
    if (!isValidAutomergeUrl(url)) {
      if (this.#announced.has(url)) return;
      return this.#announce(url, url, url);
    }
    // Pin heads once so the change baseline and the announced version come
    // from the same snapshot.
    const handle = await this.repo.find(url);
    const heads = handle.heads();
    const headsKey = heads.join(",");
    this.#attach(url, handle, headsKey);
    if (this.#announced.get(url) === headsKey) return;
    await this.#announce(handle.view(heads).url, url, headsKey);
  }

  #attach(url: string, handle: DocHandle<unknown>, headsKey: string): void {
    if (this.#disposed || this.#watched.has(url)) return;
    let announcedHeads = headsKey;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = () => {
      if (handle.heads().join(",") === announcedHeads) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const heads = handle.heads();
        const key = heads.join(",");
        if (key === announcedHeads) return;
        announcedHeads = key;
        const versioned = handle.view(heads).url;
        log(`change in ${url}, re-reading manifest at ${versioned}`);
        void this.#announce(versioned, url, key);
      }, RELOAD_DEBOUNCE_MS);
    };
    handle.on("change", listener);
    this.#watched.set(url, () => {
      if (timer) clearTimeout(timer);
      handle.off("change", listener);
    });
  }

  async #announce(
    versionUrl: string,
    key: string,
    versionKey: string
  ): Promise<void> {
    const generation = (this.#generations.get(key) ?? 0) + 1;
    this.#generations.set(key, generation);
    const current = () => this.#generations.get(key) === generation;

    const attempt = async (attemptIndex: number): Promise<void> => {
      let pkg: PatchworkPackage | undefined;
      let failed = false;
      try {
        pkg =
          (await readPackageManifest(versionUrl)) ??
          (await this.#readLegacyPackage?.(versionUrl));
      } catch (error) {
        failed = true;
        console.error(`Failed to read the package at ${versionUrl}`, error);
      }
      if (!current()) return;
      if (pkg) {
        this.#announced.set(key, versionKey);
        this.#onPackage({ ...pkg, url: key });
        return;
      }
      if (!failed) {
        console.warn(`${versionUrl} has no patchwork.json; not announcing it`);
        return;
      }
      const delay = RETRY_DELAYS_MS[attemptIndex];
      if (delay === undefined) return;
      const timer = setTimeout(() => {
        if (this.#retryTimers.get(key) === timer) this.#retryTimers.delete(key);
        if (current()) void attempt(attemptIndex + 1);
      }, delay);
      this.#retryTimers.set(key, timer);
    };
    await attempt(0);
  }

  #detach(url: string): void {
    this.#watched.get(url)?.();
    this.#watched.delete(url);
  }

  #cancel(url: string): void {
    const generation = this.#generations.get(url);
    if (generation !== undefined) this.#generations.set(url, generation + 1);
    const timer = this.#retryTimers.get(url);
    if (timer) {
      clearTimeout(timer);
      this.#retryTimers.delete(url);
    }
  }

  #unload(url: string): void {
    this.#detach(url);
    this.#cancel(url);
    this.#announced.delete(url);
    this.#onRemove?.(url);
  }

  dispose(): void {
    this.#disposed = true;
    for (const handle of this.#settingsHandles.values()) {
      handle.removeListener("change", this.#onSettingsChange);
    }
    for (const url of [...this.#watched.keys()]) this.#detach(url);
    for (const [key, generation] of this.#generations) {
      this.#generations.set(key, generation + 1);
    }
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#active.clear();
  }
}
