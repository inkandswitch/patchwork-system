/**
 * Against the real Subduction server, only with PATCHWORK_NETWORK_TESTS set:
 * the module folder docs the settings doc lists can be found.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  Repo,
  type PeerId,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

const SUBDUCTION_SERVER = "wss://subduction.sync.inkandswitch.com";
const SETTINGS_DOC_URL =
  "automerge:415R9K4Jde4ByU94X8fUDUxy2tFW" as AutomergeUrl;
const FIND_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label = ""): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

interface SettingsDoc {
  modules?: string[];
}
interface FolderDoc {
  title?: string;
  docs?: Array<{ name: string; type: string; url: string }>;
  lastSyncAt?: number;
}

const repos: Repo[] = [];
function mkRepo(id: string): Repo {
  const r = new Repo({
    peerId: id as PeerId,
    subductionWebsocketEndpoints: [SUBDUCTION_SERVER],
  });
  repos.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(repos.map((r) => r.shutdown().catch(() => {})));
  repos.length = 0;
});

describe.skipIf(!process.env.PATCHWORK_NETWORK_TESTS)(
  "subduction server sync",
  () => {
    it(
      "finds the settings doc and its modules",
      async () => {
        const repo = mkRepo("t-settings");
        await repo.networkSubsystem.whenReady();
        const h = await withTimeout(
          repo.find<SettingsDoc>(SETTINGS_DOC_URL),
          FIND_TIMEOUT_MS,
          "settings"
        );
        const doc = h.doc();
        expect(doc.modules).toBeDefined();
        expect(doc.modules!.length).toBeGreaterThan(0);
        for (const url of doc.modules!) {
          expect(url).toMatch(/^automerge:/);
        }
        console.log(`settings doc: ${doc.modules!.length} modules`);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "finds a known-good folder doc (codemirror-base)",
      async () => {
        const repo = mkRepo("t-good");
        await repo.networkSubsystem.whenReady();
        const h = await withTimeout(
          repo.find<FolderDoc>(
            "automerge:uB1jzug4TNGNNp4Ht3AFYayrZ6M" as AutomergeUrl
          ),
          FIND_TIMEOUT_MS,
          "codemirror-base"
        );
        const doc = h.doc();
        console.log(
          `codemirror-base: title="${doc.title}" docs=${doc.docs?.length}`
        );
        expect(doc.title).toBeDefined();
        expect(doc.docs!.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "finds patchwork-frame folder doc",
      async () => {
        const repo = mkRepo("t-pf");
        await repo.networkSubsystem.whenReady();
        const h = await withTimeout(
          repo.find<FolderDoc>(
            "automerge:2ibDxPG2765oqtWvSigFBeCaGCfn" as AutomergeUrl
          ),
          FIND_TIMEOUT_MS,
          "patchwork-frame"
        );
        const doc = h.doc();
        console.log(
          `patchwork-frame: title="${doc.title}" docs=${doc.docs?.length}`
        );
        expect(doc.title).toBeDefined();
        expect(doc.docs!.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "finds all 11 failing docs in parallel",
      async () => {
        const failingUrls = [
          "automerge:3ndRrJ4Jm3oYXpZ8phN1n3USXnjz",
          "automerge:2dNUx2SvMjj6wts1zbqFdP1AVVG1",
          "automerge:25ZzRmCF6xZ7neoFeUVegfTHuF4K",
          "automerge:3KMDAsqLG8UWnCQqkhQxKKddvM1Z",
          "automerge:p5kQE3r1jARV7vAzDvTvDnuokGf",
          "automerge:2CTdKn4QmBFFAanABCxhgbrU1QSj",
          "automerge:38P3tL9rira7TqACcLY8jvNH3t2B",
          "automerge:2ibDxPG2765oqtWvSigFBeCaGCfn",
          "automerge:2wDwS3zDo9ceBMuaQDhLc7JxGueZ",
          "automerge:smfxCJhz4f9ij1uZXknM6835Q9d",
          "automerge:HR7Vps32FUnR86LhHfJVeQFVj2c",
        ];

        const repo = mkRepo("t-failing11");
        await repo.networkSubsystem.whenReady();

        const results = await Promise.all(
          failingUrls.map(async (url) => {
            try {
              const h = await withTimeout(
                repo.find<FolderDoc>(url as AutomergeUrl),
                FIND_TIMEOUT_MS,
                url.slice(10, 30)
              );
              const doc = h.doc();
              const ok = (doc?.docs?.length ?? 0) > 0;
              console.log(
                `  ${ok ? "OK" : "EMPTY"}: ${url.slice(10, 30)} title="${doc?.title}" docs=${doc?.docs?.length ?? 0}`
              );
              return {
                url,
                ok,
                title: doc?.title,
                docsCount: doc?.docs?.length ?? 0,
              };
            } catch (err: any) {
              console.log(`  TIMEOUT: ${url.slice(10, 30)} ${err.message}`);
              return { url, ok: false, error: err.message };
            }
          })
        );

        const ok = results.filter((r) => r.ok).length;
        const empty = results.filter((r) => !r.ok && !(r as any).error).length;
        const timedOut = results.filter((r) => (r as any).error).length;
        console.log(
          `\n11 failing docs: ${ok} ok, ${empty} empty, ${timedOut} timed out`
        );

        expect(ok).toBe(11);
      },
      TEST_TIMEOUT_MS
    );

    it(
      "finds every listed folder doc concurrently",
      async () => {
        const repo = mkRepo("t-all26");
        await repo.networkSubsystem.whenReady();

        const sh = await withTimeout(
          repo.find<SettingsDoc>(SETTINGS_DOC_URL),
          FIND_TIMEOUT_MS,
          "settings"
        );
        const modules = sh.doc().modules ?? [];

        const results = await Promise.all(
          modules.map(async (url) => {
            try {
              const h = await withTimeout(
                repo.find<FolderDoc>(url as AutomergeUrl),
                FIND_TIMEOUT_MS,
                url.slice(10, 30)
              );
              const doc = h.doc();
              const hasDocs = (doc?.docs?.length ?? 0) > 0;
              console.log(
                `  ${hasDocs ? "OK" : "EMPTY"}: ${url.slice(10, 30)} title="${doc?.title}" docs=${doc?.docs?.length ?? 0}`
              );
              return { url, ok: hasDocs };
            } catch (err: any) {
              console.log(`  TIMEOUT: ${url.slice(10, 30)}`);
              return { url, ok: false };
            }
          })
        );

        const ok = results.filter((r) => r.ok).length;
        console.log(`\nAll modules: ${ok}/${modules.length} have docs`);
        expect(modules.length).toBeGreaterThan(0);
        expect(ok).toBe(modules.length);
      },
      TEST_TIMEOUT_MS
    );
  }
);
