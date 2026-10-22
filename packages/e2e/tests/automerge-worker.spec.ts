import { expect, test, type Page } from "@playwright/test";
import {
  createDoc,
  waitForRepoReady,
  waitForServiceWorkerActive,
} from "./helpers.js";

/**
 * The automerge worker (a SharedWorker) holds a Web Lock for its lifetime, and
 * the service worker checks for it before handing an `automerge:` request
 * off: no lock, no worker, so it asks the tabs to start one.
 *
 * A worker that's been spawned but is still evaluating its imports hasn't
 * asked for the lock yet. Requests made in that window mustn't be mistaken
 * for a missing worker: each tab answers the nudge by dropping its connection
 * to the booting worker and reconnecting sync.
 */

// AUTOMERGE_WORKER_LOCK in core/bootloader/src/types.ts.
const LOCK = "@patchwork/automerge-worker";

function workerLockHeld(page: Page): Promise<boolean> {
  return page.evaluate(async (lock) => {
    const { held = [] } = await navigator.locks.query();
    return held.some((l) => l.name === lock && l.mode === "exclusive");
  }, LOCK);
}

declare global {
  interface Window {
    missingWorkerNudges: number;
    lockedAtSpawn: Promise<boolean>;
  }
}

test("the automerge worker holds its lock once the tab is up", async ({
  page,
}) => {
  await page.goto("/");
  await waitForServiceWorkerActive(page);
  await waitForRepoReady(page);
  // Not holding it means it failed before taking it, or it's a build from
  // before the lock: either way every handoff would nudge the tabs.
  await expect.poll(() => workerLockHeld(page)).toBe(true);
});

test("an automerge worker that's still booting isn't reported missing", async ({
  context,
}) => {
  const first = await context.newPage();
  await first.goto("/");
  await waitForServiceWorkerActive(first);
  await waitForRepoReady(first);
  const url = await createDoc(first, { title: "booting" });
  await first.close();

  // The worker goes with its last tab. Wait for that from a same-origin page
  // that doesn't boot the app, so the next tab has to start a fresh one.
  const probe = await context.newPage();
  await probe.goto("/automerge-protocol-handler-worker.js");
  await expect.poll(() => workerLockHeld(probe)).toBe(false);
  await probe.close();

  const tab = await context.newPage();
  await tab.addInitScript(
    ([lock, docUrl]) => {
      if (location.pathname !== "/") return;
      window.missingWorkerNudges = 0;
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "automerge-worker-missing") {
          window.missingWorkerNudges++;
        }
      });
      // Right as the tab spawns the worker, so the request reaches the
      // service worker while the worker is booting. Any earlier and there
      // really is no worker yet, which a page slow to get this far (Firefox,
      // often) would be right to be told about.
      const SharedWorker = window.SharedWorker;
      let raced = false;
      class Racing extends SharedWorker {
        constructor(url: string | URL, options?: string | WorkerOptions) {
          if (!raced && String(url).includes("automerge-protocol-handler")) {
            raced = true;
            window.lockedAtSpawn = navigator.locks
              .query()
              .then(({ held = [] }) => held.some((l) => l.name === lock));
            void fetch(`/${encodeURIComponent(docUrl)}`, {
              redirect: "manual",
            }).catch(() => {});
          }
          super(url, options);
        }
      }
      window.SharedWorker = Racing;
    },
    [LOCK, url] as const
  );
  await tab.goto("/");
  await waitForRepoReady(tab);

  // Otherwise this passes without having raced anything.
  expect(await tab.evaluate(() => window.lockedAtSpawn)).toBe(false);

  await expect.poll(() => workerLockHeld(tab)).toBe(true);
  // Past the service worker's grace period, so a nudge would have landed.
  await tab.waitForTimeout(5_000);
  expect(await tab.evaluate(() => window.missingWorkerNudges)).toBe(0);
});
