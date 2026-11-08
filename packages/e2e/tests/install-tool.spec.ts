import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { waitForRepoReady } from "./helpers.js";

/**
 * The extensibility loop: install a package at runtime, then use the tool it
 * ships. The one-file counter module (fixtures/counter.js) is written into a
 * directory doc, which the service worker serves same-origin under
 * /automerge%3A<id>/…, and its url is pasted into the Packages filter and
 * confirmed in the modal. That puts it on the account's module-settings doc,
 * the ModuleWatcher hot-loads it, its datatype appears in the create-new
 * menu, and its tool renders the doc.
 *
 * It needs the full UI, so like cross-profile-sync it runs on chromium only.
 */

const COUNTER_SOURCE = readFileSync(
  new URL("../fixtures/counter.js", import.meta.url),
  "utf8",
);

test("a counter tool installed from an automerge url can be created and clicked", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "full-UI boot is only reliable on chromium: firefox fails cors fetches from inside service workers, webkit is flaky on SW timing and emulation");
  test.setTimeout(300_000);

  await page.goto("/", { timeout: 120_000 });
  await page.waitForSelector(".threepane-sidebar", { timeout: 180_000 });
  await waitForRepoReady(page);

  const packageUrl = await page.evaluate((source) => {
    const handle = window.repo.create<Record<string, unknown>>();
    handle.change((d) => {
      d["@patchwork"] = { type: "directory" };
      d["package.json"] = {
        content: JSON.stringify({
          name: "e2e-counter",
          version: "1.0.0",
          main: "./index.js",
        }),
        mimeType: "application/json",
      };
      d["index.js"] = { content: source, mimeType: "text/javascript" };
    });
    return handle.url;
  }, COUNTER_SOURCE);

  await page.getByRole("button", { name: "Packages" }).click();
  const search = page.locator(".pw-packages__search");
  await expect(search).toBeVisible({ timeout: 30_000 });

  // On webkit the Add click can be swallowed while the modal is still
  // settling, so retry the whole install until the "my package list" plugin
  // count proves the settings doc took the module (the counter package
  // registers 2 plugins: the datatype and the tool).
  const install = page.locator(".pw-install");
  const installedCount = page.locator(
    '.pw-packages__origin-chip[data-origin="installed"] .pw-packages__origin-count',
  );
  await expect(async () => {
    if ((await installedCount.textContent()) === "0") {
      await page.keyboard.press("Escape");
      await search.fill("");
      // Only a paste opens the install modal (typing a URL just filters by
      // it), and fill() fires input, not paste, so dispatch one ourselves.
      await search.evaluate((el, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, packageUrl);
      await expect(install.locator(".pw-install__card")).toBeVisible({
        timeout: 10_000,
      });
      await install
        .getByRole("button", { name: "Add to my package list" })
        .click();
    }
    await expect(installedCount).not.toHaveText("0", { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  // The module loads in the background after install; an already-open menu
  // may not pick it up (seen on webkit), so reopen the menu until the
  // datatype is listed.
  const counterItem = page.locator(".popmenu__item", { hasText: "Counter" });
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "create new" }).click();
    await expect(counterItem).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await counterItem.click();

  const counter = page.locator(".e2e-counter");
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const count = counter.locator(".e2e-counter__count");
  await expect(count).toHaveText("0");

  const increment = counter.locator(".e2e-counter__increment");
  await increment.click();
  await increment.click();
  await increment.click();
  await expect(count).toHaveText("3");

  // Reloading straight away can come before the last increments are saved,
  // so first prove count=3 has left this tab by reading the doc from another.
  const docUrl = await page.evaluate(
    () => new URLSearchParams(location.hash.slice(1)).get("doc")!,
  );
  const checkTab = await page.context().newPage();
  await checkTab.goto("/");
  await waitForRepoReady(checkTab);
  await expect
    .poll(
      () =>
        checkTab.evaluate(async (u) => {
          const handle = await window.repo.find<{ count: number }>(u);
          return handle.doc().count;
        }, docUrl),
      { timeout: 30_000 },
    )
    .toBe(3);
  await checkTab.close();

  // The installed module and the doc both survive a reload: the settings doc
  // re-loads the package, the hash re-opens the counter.
  await page.reload();
  await expect(page.locator(".e2e-counter__count")).toHaveText("3", {
    timeout: 90_000,
  });
});
