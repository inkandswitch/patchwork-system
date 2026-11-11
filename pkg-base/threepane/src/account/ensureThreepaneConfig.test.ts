import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import { ensureThreepaneConfig } from "./ensureThreepaneConfig";
import { uniqueSlots } from "../components/SlotView";
import {
  DEFAULT_DOCTITLE_TOOLS,
  DEFAULT_TRAY_TOOLS,
  DOCUMENT_LIST_TOOL,
  THREEPANE_CONFIG_VERSION,
  ThreepaneConfigDatatype,
} from "../datatypes";
import type { ThreepaneConfigDoc } from "../types";

vi.mock("@inkandswitch/patchwork-plugins", () => ({
  createDocOfDatatype2: vi.fn(),
  getRegistry: vi.fn(),
}));

vi.mock("./loadDatatypeWhenReady", () => ({
  loadDatatypeWhenReady: vi.fn(async () => ({})),
}));

const ROOT = "automerge:root";

/** A fake DocHandle over a plain object; counts changes. */
function fakeHandle<T>(doc: T, url = "automerge:config") {
  return {
    url,
    doc: () => doc,
    change: vi.fn((fn: (d: T) => void) => fn(doc)),
  };
}

function oldConfig(): ThreepaneConfigDoc {
  return {
    sidebar: { widgets: [] },
    doctitle: { tools: ["doc-openwith"] },
    tray: ["theme-tray", "llm-config-tray", "llm-config-tray"],
  };
}

function setup(config: ThreepaneConfigDoc, rootFolderUrl: string | null = ROOT) {
  const configHandle = fakeHandle(config);
  const account: any = { rootFolderUrl: rootFolderUrl ?? undefined, tools: { threepane: "automerge:config" } };
  const accountHandle = fakeHandle(account, "automerge:account");
  const repo = { find: vi.fn(async () => configHandle) };
  const run = () => ensureThreepaneConfig(accountHandle as any, repo as any);
  return { configHandle, run };
}

beforeEach(() => vi.clearAllMocks());

describe("tray slots", () => {
  it("keeps the first slot for each tool, including tuple slots", () => {
    const slots = ["theme-tray", "llm-config-tray", ["llm-config-tray", "doc"], "other", "llm-config-tray"] as any;
    expect(uniqueSlots(slots)).toEqual(["theme-tray", "llm-config-tray", "other"]);
  });
});

describe("ensureThreepaneConfig", () => {
  it("creates a new config with every default and the current version", async () => {
    const config = {} as ThreepaneConfigDoc;
    ThreepaneConfigDatatype.init!(config as any, undefined as any);
    const configHandle = fakeHandle(config, "automerge:new");
    vi.mocked(createDocOfDatatype2).mockResolvedValue(configHandle as any);
    const account: any = { rootFolderUrl: ROOT };
    const accountHandle = fakeHandle(account, "automerge:account");

    await ensureThreepaneConfig(accountHandle as any, {} as any);

    expect(account.tools.threepane).toBe("automerge:new");
    expect(config.sidebar.widgets).toEqual([[DOCUMENT_LIST_TOOL, ROOT]]);
    expect(config.tray).toEqual(DEFAULT_TRAY_TOOLS);
    expect(config.doctitle.tools).toEqual(DEFAULT_DOCTITLE_TOOLS);
    expect(config.version).toBe(THREEPANE_CONFIG_VERSION);
  });

  it("migrates an unversioned config once, then leaves it alone", async () => {
    const config = oldConfig();
    const { configHandle, run } = setup(config);

    await run();
    expect(config.sidebar.widgets).toEqual([[DOCUMENT_LIST_TOOL, ROOT]]);
    expect(config.tray).toEqual(["theme-tray", "llm-config-tray"]);
    expect(config.doctitle.tools).toEqual(["doc-openwith"]);
    expect(config.version).toBe(THREEPANE_CONFIG_VERSION);

    await run();
    expect(configHandle.change).toHaveBeenCalledTimes(1);
  });

  it("does not bring back defaults the person removed", async () => {
    const config = oldConfig();
    const { run } = setup(config);
    await run();

    config.tray = ["theme-tray"];
    config.sidebar.widgets = [];
    config.doctitle.tools = [];
    await run();

    expect(config.tray).toEqual(["theme-tray"]);
    expect(config.sidebar.widgets).toEqual([]);
    expect(config.doctitle.tools).toEqual([]);
  });

  it("keeps the migration pending until the account has a root folder", async () => {
    const config = oldConfig();
    const { run } = setup(config, null);
    await run();
    expect(config.version).toBeUndefined();
    expect(config.sidebar.widgets).toEqual([]);
  });
});
