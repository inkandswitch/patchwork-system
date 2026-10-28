import { test, expect } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

// Records what each browser does; it only fails if the page never reports.
test("service worker ↔ shared worker messaging", async ({ page, browserName }) => {
  page.on("console", (message) => console.log(`[${browserName}] ${message.text()}`));
  await page.goto("/");
  const handle = await page.waitForFunction(() => window.__results, null, {
    timeout: 45_000,
  });
  const results = await handle.jsonValue();
  const json = JSON.stringify(results, null, 2);
  console.log(json);

  const dir = new URL("./results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${browserName}.json`, dir), json);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${browserName}\n\n\`\`\`json\n${json}\n\`\`\`\n`
    );
  }
  expect(results.error).toBeUndefined();
});
