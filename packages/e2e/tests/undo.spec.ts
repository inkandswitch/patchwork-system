import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitForRepoReady } from "./helpers.js";

/**
 * Undo and redo as a service (@inkandswitch/patchwork-undo), driven with
 * real keys and clicks. The example tools from packages/undo/examples are
 * loaded into the page as modules, so their bare imports resolve through
 * the site's import map: they run against the packages the site ships.
 *
 * The collaboration scenario uses two browser profiles (separate contexts,
 * separate actors) syncing through the site's sync server, so it needs the
 * network.
 *
 * PATCHWORK_E2E_UNDO_PATH names the page to start from (default `/`); any
 * page that sets `window.repo` and carries the import map will do, e.g. the
 * bench site's `/?mode=patchwork`.
 */

const START = process.env.PATCHWORK_E2E_UNDO_PATH ?? "/";
// Longer than the 500 ms grouping delay, so each typed letter is a step.
const STEP_GAP = 700;

const EXAMPLES = ["text", "canvas", "form", "edit-menu"] as const;

// From dist/tests, the build copies the examples into dist/fixtures; from
// the source tree they are next door in packages/undo.
function exampleSource(name: string): string {
  for (const candidate of [
    `../fixtures/undo-examples/${name}.js`,
    `../../undo/examples/${name}.js`,
  ]) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error(`undo example ${name} not found`);
}

const sources = Object.fromEntries(EXAMPLES.map((n) => [n, exampleSource(n)]));

/** Boot, load the examples and an `<undo-provider>`, and add a stage. */
async function boot(page: Page) {
  await page.goto(START, { timeout: 120_000 });
  await waitForRepoReady(page, 120_000);
  await page.evaluate(async (sources) => {
    const load = (source: string) =>
      import(
        /* @vite-ignore */
        URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
      );
    const w = window as any;
    w.undoExamples = {};
    for (const [name, source] of Object.entries(sources)) {
      w.undoExamples[name] = await load(source);
    }
    w.undoLib = await load(
      `export * from "@inkandswitch/patchwork-undo";
       export { OverlayHandle } from "@inkandswitch/patchwork-providers";`
    );
    w.undoLib.registerUndoProviderElement();
    // A document another profile just created may not have reached the
    // sync server yet; `find` then settles unavailable. Ask again.
    w.undoFind = async (url: string) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        try {
          return await w.repo.find(url);
        } catch (err) {
          if (Date.now() > deadline) throw err;
          w.repo.resyncSubduction?.(url.replace(/^automerge:/, ""));
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    };
    let provider = document.querySelector("undo-provider");
    if (!provider) {
      provider = document.createElement("undo-provider");
      document.body.append(provider);
    }
    const stage = document.createElement("div");
    stage.id = "undo-stage";
    stage.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:white;padding:8px;display:flex;flex-direction:column;gap:8px";
    provider.append(stage);
  }, sources);
}

/** Mount an example tool into a new box on the stage; returns its selector. */
async function mount(
  page: Page,
  example: "text" | "canvas" | "form",
  url: string,
  options: Record<string, unknown> = {}
) {
  return page.evaluate(
    async ({ example, url, options }) => {
      const w = window as any;
      const handle = await w.undoFind(url);
      const box = document.createElement("div");
      box.id = `tool-${Math.random().toString(36).slice(2)}`;
      box.style.cssText = "border:1px solid #888;min-height:40px";
      document.getElementById("undo-stage")!.append(box);
      const mounts: Record<string, string> = {
        text: "mountText",
        canvas: "mountCanvas",
        form: "mountForm",
      };
      w.undoExamples[example][mounts[example]!](handle, box, options);
      return `#${box.id}`;
    },
    { example, url, options }
  );
}

async function create(page: Page, value: Record<string, unknown>) {
  return page.evaluate((value) => {
    const handle = window.repo.create<Record<string, unknown>>();
    handle.change((d) => Object.assign(d, value));
    return handle.url;
  }, value);
}

async function read(page: Page, url: string) {
  return page.evaluate(async (url) => {
    const handle = await (window as any).undoFind(url);
    return JSON.parse(JSON.stringify(handle.doc()));
  }, url);
}

// Mod as the page sees it: Playwright's device profiles emulate a platform
// (Desktop Chrome is Windows) that needn't be the host's, which is what
// `ControlOrMeta` follows.
async function mod(page: Page) {
  const mac = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  );
  return mac ? "Meta" : "Control";
}
const undo = async (page: Page) => page.keyboard.press(`${await mod(page)}+z`);
const redo = async (page: Page) =>
  page.keyboard.press(`${await mod(page)}+Shift+z`);

test.describe("undo service", () => {
  test.describe.configure({ timeout: 300_000 });

  test("the collaboration scenario, typed by two profiles", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "two-profile sync through the sync server is only reliable on chromium (see cross-profile-sync)"
    );
    await collaboration(browser);
  });

  test("a canvas without focus: undo, then redo", async ({ page }) => {
    await boot(page);
    const url = await create(page, { dots: [] });
    const tool = await mount(page, "canvas", url);
    const canvas = page.locator(`${tool} canvas`);
    await canvas.click({ position: { x: 20, y: 20 } });
    await canvas.click({ position: { x: 60, y: 40 } });
    await expect.poll(async () => (await read(page, url)).dots.length).toBe(2);
    // The canvas has no focus: the keys go to the document used last.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      "BODY"
    );
    await undo(page);
    await expect.poll(async () => (await read(page, url)).dots.length).toBe(1);
    await undo(page);
    await expect.poll(async () => (await read(page, url)).dots.length).toBe(0);
    await redo(page);
    await expect.poll(async () => (await read(page, url)).dots.length).toBe(1);
  });

  test("a form field keeps its own undo", async ({ page }) => {
    await boot(page);
    const url = await create(page, { title: "", items: [] });
    const tool = await mount(page, "form", url);
    await page.locator(`${tool} button`).click();
    await expect
      .poll(async () => (await read(page, url)).items)
      .toEqual(["item 1"]);
    const title = page.locator(`${tool} input`);
    await title.click();
    await page.keyboard.type("Groceries");
    await expect
      .poll(async () => (await read(page, url)).title)
      .toBe("Groceries");
    // In the field, Mod+Z is left to the browser: the service doesn't take
    // the event, and the document keeps its list. (What the browser then
    // does depends on the host's platform, not the emulated one.)
    await page.evaluate(() => {
      window.addEventListener("keydown", (e) => {
        (window as any).lastKeyTaken = e.defaultPrevented;
      });
    });
    await undo(page);
    expect(await page.evaluate(() => (window as any).lastKeyTaken)).toBe(false);
    expect((await read(page, url)).items).toEqual(["item 1"]);
    // Outside it, Mod+Z undoes the document: the title, then the item.
    await page.locator(`${tool} button`).focus();
    await undo(page);
    await expect.poll(async () => (await read(page, url)).title).toBe("");
    await undo(page);
    await expect.poll(async () => (await read(page, url)).items).toEqual([]);
  });

  test("the edit menu follows the document; a draft swap resets the history", async ({
    page,
  }) => {
    await boot(page);
    const baseUrl = await create(page, { text: "" });
    // A draft: an OverlayHandle presenting the base, backed by the base, then
    // swapped to a clone, as a draft remapper does.
    const tool = await page.evaluate(async (baseUrl) => {
      const w = window as any;
      const base = await w.repo.find(baseUrl);
      const overlay = new w.undoLib.OverlayHandle({
        presentedUrl: baseUrl,
        backing: base,
      });
      w.undoOverlay = overlay;
      const box = document.createElement("div");
      box.id = "draft-tool";
      document.getElementById("undo-stage")!.append(box);
      w.undoExamples.text.mountText(overlay, box);
      const menu = document.createElement("nav");
      document.getElementById("undo-stage")!.prepend(menu);
      w.undoExamples["edit-menu"].mountEditMenu(menu);
      return "#draft-tool";
    }, baseUrl);
    const undoButton = page.locator(".undo-example-undo");
    const redoButton = page.locator(".undo-example-redo");
    await expect(undoButton).toBeDisabled();

    await page.locator(`${tool} .cm-content`).click();
    await page.keyboard.type("draft");
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect.poll(async () => (await read(page, baseUrl)).text).toBe("");
    await expect(redoButton).toBeEnabled();
    await redoButton.click();
    await expect
      .poll(async () => (await read(page, baseUrl)).text)
      .toBe("draft");

    const cloneUrl = await page.evaluate(async () => {
      const w = window as any;
      const clone = w.repo.clone(w.undoOverlay.backingHandle);
      w.undoOverlay.swapBackingDocHandle(clone);
      return clone.url;
    });
    await expect(undoButton).toBeDisabled();
    await page.locator(`${tool} .cm-content`).click();
    await undo(page);
    expect((await read(page, cloneUrl)).text).toBe("draft");
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect
      .poll(async () => (await read(page, cloneUrl)).text)
      .toBe("draft!");
    expect((await read(page, baseUrl)).text).toBe("draft");
    await undo(page);
    await expect
      .poll(async () => (await read(page, cloneUrl)).text)
      .toBe("draft");
  });
});

/**
 * The tldraw fixture bundled for the page, or undefined where tldraw or
 * esbuild aren't installed (a site repo running the published suite).
 */
async function tldrawBundle(): Promise<string | undefined> {
  const entry = new URL("../fixtures/undo-tldraw.js", import.meta.url);
  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [fileURLToPath(entry)],
      bundle: true,
      format: "esm",
      write: false,
      minify: true,
      external: ["@automerge/*", "@inkandswitch/*"],
      loader: { ".css": "text" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    return result.outputFiles[0]!.text;
  } catch {
    return undefined;
  }
}

type Shape = {
  type: string;
  geo?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
};

async function shapes(page: Page, side: "own" | "bound"): Promise<Shape[]> {
  return page.evaluate((side) => {
    const editor = (window as any).tldraw[side];
    return editor
      .getCurrentPageShapes()
      .map((s: any) => ({
        type: s.type,
        geo: s.props.geo,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: Math.round(s.props.w),
        h: Math.round(s.props.h),
      }))
      .sort((a: Shape, b: Shape) => a.x - b.x || a.y - b.y);
  }, side);
}

test.describe("undo service with tldraw", () => {
  test.describe.configure({ timeout: 300_000 });

  test("tldraw's own history and the service give the same shapes", async ({
    page,
  }) => {
    const bundle = await tldrawBundle();
    test.skip(
      !bundle,
      "tldraw and esbuild are dev dependencies of this repo only"
    );
    await page.setViewportSize({ width: 1600, height: 900 });
    await boot(page);
    const url = await create(page, {});
    await page.evaluate(
      async ({ bundle, url }) => {
        const w = window as any;
        const { mount } = await import(
          /* @vite-ignore */
          URL.createObjectURL(new Blob([bundle], { type: "text/javascript" }))
        );
        const stage = document.getElementById("undo-stage")!;
        stage.style.flexDirection = "row";
        const box = (id: string) => {
          const el = document.createElement("div");
          el.id = id;
          el.style.cssText = "position:relative;width:760px;height:860px";
          stage.append(el);
          return el;
        };
        const handle = await w.undoFind(url);
        w.tldraw = {
          own: await mount(box("tldraw-own"), handle, { bound: false }),
          bound: await mount(box("tldraw-bound"), handle, { bound: true }),
        };
      },
      { bundle: bundle!, url }
    );

    // The same mouse and keyboard actions on each editor.
    const act = async (side: "own" | "bound") => {
      const box = (await page.locator(`#tldraw-${side}`).boundingBox())!;
      const at = (x: number, y: number) => [box.x + x, box.y + y] as const;
      const drag = async (
        from: readonly [number, number],
        to: readonly [number, number],
        pause = 0
      ) => {
        await page.mouse.move(...from);
        await page.mouse.down();
        const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] as const;
        await page.mouse.move(...mid, { steps: 5 });
        if (pause) await page.waitForTimeout(pause);
        await page.mouse.move(...to, { steps: 5 });
        await page.mouse.up();
      };
      await page.mouse.click(...at(400, 600));
      // draw
      await page.keyboard.press("r");
      await drag(at(200, 200), at(320, 300));
      // draw with a pause mid-drag
      await page.keyboard.press("r");
      await drag(at(420, 200), at(560, 320), 1500);
      // move (the shapes are hollow: take the first one by its edge)
      await page.keyboard.press("v");
      await drag(at(200, 250), at(240, 450));
      // delete the second, also picked by its edge
      await page.mouse.click(...at(420, 260));
      await page.keyboard.press("Delete");
    };
    await act("own");
    await act("bound");
    expect(await shapes(page, "bound")).toEqual(await shapes(page, "own"));
    expect(await shapes(page, "own")).toHaveLength(1);

    const press = async (side: "own" | "bound", redo: boolean) => {
      // Both editors listen for shortcuts on the body and act while they
      // think they're focused: blur the other one. Then focus this one as a
      // user's click would (a DOM focusin, which tells the realm which tool
      // is in use), without a click's history mark.
      await page.evaluate(
        (other) => {
          (window as any).tldraw[other].blur();
        },
        side === "own" ? "bound" : "own"
      );
      await page.locator(`#tldraw-${side} .tl-container`).focus();
      await page.evaluate((side) => {
        (window as any).tldraw[side].focus();
      }, side);
      await page.keyboard.press(`${await mod(page)}+${redo ? "Shift+" : ""}z`);
    };
    const can = (what: "canUndo" | "canRedo") =>
      page.evaluate((what) => (window as any).tldraw.own[what](), what);
    // tldraw's own history also has steps that only change the selection
    // (session state, not in the document): its undo is pressed until the
    // shapes change, the service's once, since it skips what isn't visible.
    let presses = 0;
    for (const redo of [false, true]) {
      for (;;) {
        const before = JSON.stringify(await shapes(page, "own"));
        for (
          let tries = 0;
          tries < 10 &&
          (await can(redo ? "canRedo" : "canUndo")) &&
          JSON.stringify(await shapes(page, "own")) === before;
          tries++
        ) {
          await press("own", redo);
        }
        if (JSON.stringify(await shapes(page, "own")) === before) break;
        await press("bound", redo);
        presses++;
        await expect
          .poll(() => shapes(page, "bound"), { message: `press ${presses}` })
          .toEqual(await shapes(page, "own"));
      }
    }
    // undo: delete, move, draw, draw; redo: the same four
    expect(presses).toBe(8);
  });
});

async function collaboration(browser: Browser) {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  try {
    await boot(alice);
    await boot(bob);
    const url = await create(alice, { alice: "", bob: "" });
    // Each profile edits its own section of the shared document.
    const aliceTool = await mount(alice, "text", url, { path: ["alice"] });
    const bobTool = await mount(bob, "text", url, { path: ["bob"] });
    await expect
      .poll(() => read(bob, url), { timeout: 90_000 })
      .toEqual({
        alice: "",
        bob: "",
      });

    const edit = async (page: Page, tool: string, letter: string) => {
      await page.waitForTimeout(STEP_GAP);
      await page.locator(`${tool} .cm-content`).click();
      await page.keyboard.press(`${await mod(page)}+End`);
      await page.keyboard.type(letter);
    };
    const press = async (page: Page, tool: string) => {
      await page.locator(`${tool} .cm-content`).click();
      await undo(page);
    };

    const steps: Array<[string, () => Promise<void>, string, string]> = [
      ["Alice A", () => edit(alice, aliceTool, "A"), "A", ""],
      ["Bob B", () => edit(bob, bobTool, "B"), "A", "B"],
      ["Alice C", () => edit(alice, aliceTool, "C"), "AC", "B"],
      ["Bob D", () => edit(bob, bobTool, "D"), "AC", "BD"],
      ["Alice E", () => edit(alice, aliceTool, "E"), "ACE", "BD"],
      ["Bob F", () => edit(bob, bobTool, "F"), "ACE", "BDF"],
      ["Alice undoes E", () => press(alice, aliceTool), "AC", "BDF"],
      ["Alice undoes C", () => press(alice, aliceTool), "A", "BDF"],
      ["Bob H", () => edit(bob, bobTool, "H"), "A", "BDFH"],
      ["Alice I", () => edit(alice, aliceTool, "I"), "AI", "BDFH"],
      ["Bob undoes H", () => press(bob, bobTool), "AI", "BDF"],
      ["Alice undoes I", () => press(alice, aliceTool), "A", "BDF"],
      [
        "Alice undoes G (C and E come back)",
        () => press(alice, aliceTool),
        "ACE",
        "BDF",
      ],
      ["Alice undoes E", () => press(alice, aliceTool), "AC", "BDF"],
      ["Bob L", () => edit(bob, bobTool, "L"), "AC", "BDFL"],
    ];
    for (const [name, act, a, b] of steps) {
      await act();
      for (const page of [alice, bob]) {
        await expect
          .poll(() => read(page, url), { message: name, timeout: 90_000 })
          .toEqual({ alice: a, bob: b });
      }
    }
  } finally {
    await alice.context().close();
    await bob.context().close();
  }
}
