/**
 * Manage module-settings docs over Subduction (see USAGE below).
 *
 * One-time PATH setup, from the repo root: `pnpm run link-cli`, then put
 * pnpm's global bin on PATH if it isn't (`pnpm bin -g`). If an older version
 * is linked, `pnpm unlink --global` first.
 *
 * From a tool package:
 *   MODULE_SETTINGS_DOC_URL='automerge:…' pnpm run register
 *   MODULE_SETTINGS_DOC_URL='automerge:…' pnpm run unregister
 *
 * Or from anywhere:
 *   pw-modules add    "$MODULE_SETTINGS_DOC_URL" "$(pushwork url)"
 *   pw-modules remove "$MODULE_SETTINGS_DOC_URL" "$(pushwork url)"
 *   pw-modules init
 *
 * AUTOMERGE_DATA_DIR defaults to <this-folder>/automerge-repo-data.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";

type ModuleSettingsDoc = {
  "@patchwork"?: { type: "patchwork:module-settings" };
  modules?: AutomergeUrl[];
};

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  pw-modules add    <automerge:settings-url> <automerge:module-url>
  pw-modules remove <automerge:settings-url> <automerge:module-url>
  pw-modules init
  pw-modules <automerge:settings-url> <automerge:module-url>   (legacy → add)

Env: SUBDUCTION_SERVER, AUTOMERGE_DATA_DIR`;

// Loose (the real parse is upstream's), but enough to catch `$(pushwork url)`
// handing back error text.
const AUTOMERGE_URL_RE = /^automerge:[1-9A-HJ-NP-Za-km-z]+$/;

function requireAutomergeUrl(label: string, value: string): AutomergeUrl {
  if (!AUTOMERGE_URL_RE.test(value)) {
    console.error(
      `Invalid ${label}: ${JSON.stringify(value)}\n` +
        `Expected an Automerge URL of the form automerge:XXXXX.\n` +
        `(If this came from \`$(pushwork url)\`, the source directory may ` +
        `not be initialized for sync.)`,
    );
    process.exit(1);
  }
  return value as AutomergeUrl;
}

function parseCommand(argv: string[]): {
  cmd: "add" | "remove" | "init";
  settingsUrl?: AutomergeUrl;
  moduleUrl?: AutomergeUrl;
} {
  const [, , ...rest] = argv;
  const first = rest[0];

  if (!first) {
    console.error(USAGE);
    process.exit(1);
  }

  if (first === "add" || first === "remove") {
    const [, settingsArg, moduleArg] = rest;
    if (!settingsArg || !moduleArg) {
      console.error(USAGE);
      process.exit(1);
    }
    return {
      cmd: first,
      settingsUrl: requireAutomergeUrl("settings URL", settingsArg),
      moduleUrl: requireAutomergeUrl("module URL", moduleArg),
    };
  }

  if (first === "init") {
    return { cmd: "init" };
  }

  // Legacy positional form: <settings-url> <module-url>
  if (first.startsWith("automerge:")) {
    const moduleArg = rest[1];
    if (!moduleArg) {
      console.error(USAGE);
      process.exit(1);
    }
    return {
      cmd: "add",
      settingsUrl: requireAutomergeUrl("settings URL", first),
      moduleUrl: requireAutomergeUrl("module URL", moduleArg),
    };
  }

  console.error(`Unknown command: ${first}\n\n${USAGE}`);
  process.exit(1);
}

async function openRepo(): Promise<Repo> {
  const subductionServer =
    process.env.SUBDUCTION_SERVER ?? "wss://subduction.sync.inkandswitch.com";
  const dataDir = path.resolve(
    process.env.AUTOMERGE_DATA_DIR ?? path.join(here, "automerge-repo-data"),
  );
  await mkdir(dataDir, { recursive: true });

  await import("@automerge/automerge-subduction");
  const { Repo } = await import("@automerge/automerge-repo");
  const { NodeFSStorageAdapter } = await import(
    "@automerge/automerge-repo-storage-nodefs"
  );

  return new Repo({
    storage: new NodeFSStorageAdapter(dataDir),
    subductionWebsocketEndpoints: [subductionServer],
  });
}

// Subduction's local head stability doesn't confirm server receipt; give
// syncWithAllPeers a moment to land before we tear down. Remove once
// awaitSynced() lands upstream.
async function syncAndShutdown(repo: Repo) {
  await new Promise((r) => setTimeout(r, 1000));
  await repo.flush();
  await repo.shutdown();
  await new Promise((r) => setTimeout(r, 2500));
}

async function add(settingsUrl: AutomergeUrl, moduleUrl: AutomergeUrl) {
  const repo = await openRepo();
  const handle = await repo.find<ModuleSettingsDoc>(settingsUrl);
  await handle.whenReady();

  let added = false;
  handle.change((doc) => {
    if (!doc.modules) doc.modules = [];
    if (!doc.modules.includes(moduleUrl)) {
      doc.modules.push(moduleUrl);
      added = true;
    }
  });

  await syncAndShutdown(repo);

  console.log(
    added
      ? `Added ${moduleUrl} → ${settingsUrl}`
      : `${moduleUrl} already in ${settingsUrl}`,
  );
}

async function remove(settingsUrl: AutomergeUrl, moduleUrl: AutomergeUrl) {
  const repo = await openRepo();
  const handle = await repo.find<ModuleSettingsDoc>(settingsUrl);
  await handle.whenReady();

  let removed = false;
  handle.change((doc) => {
    if (!doc.modules) return;
    const idx = doc.modules.indexOf(moduleUrl);
    if (idx !== -1) {
      doc.modules.splice(idx, 1);
      removed = true;
    }
  });

  await syncAndShutdown(repo);

  console.log(
    removed
      ? `Removed ${moduleUrl} from ${settingsUrl}`
      : `${moduleUrl} was not in ${settingsUrl}`,
  );
}

async function init() {
  const repo = await openRepo();
  const handle = repo.create<ModuleSettingsDoc>({
    ["@patchwork"]: { type: "patchwork:module-settings" },
    modules: [],
  });
  await handle.whenReady();

  const url = handle.url;

  await syncAndShutdown(repo);

  // Human message to stderr; bare URL to stdout so callers can capture it:
  //   MODULE_SETTINGS_DOC_URL=$(pw-modules init)
  console.error(`Created module-settings doc: ${url}`);
  console.log(url);
}

const parsed = parseCommand(process.argv);

switch (parsed.cmd) {
  case "add":
    await add(parsed.settingsUrl!, parsed.moduleUrl!);
    break;
  case "remove":
    await remove(parsed.settingsUrl!, parsed.moduleUrl!);
    break;
  case "init":
    await init();
    break;
}

// Subduction leaves the wss TLSSocket open after repo.shutdown(); exit explicitly for this CLI.
process.exit(0);
