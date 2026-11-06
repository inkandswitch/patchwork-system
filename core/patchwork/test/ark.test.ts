import { describe, expect, it } from "vitest";

import { resolvePrimarySyncServer } from "../src/site-kit/sync-servers.js";
import { ark, arkAliases, arkStack } from "../src/vite/ark-plugin.js";

const STAGING = "wss://staging.subduction.sync.inkandswitch.com";

describe("keyhive.ark", () => {
  it("defaults to 0.6 on subduction.sync.inkandswitch.com", () => {
    expect(resolvePrimarySyncServer({ keyhive: true }).ark).toBe("0.6");
    expect(
      resolvePrimarySyncServer({
        keyhive: true,
        syncServers: { subduction: "wss://subduction.sync.inkandswitch.com/" },
      }).ark
    ).toBe("0.6");
  });

  it("defaults to 0.8 on any other server", () => {
    expect(
      resolvePrimarySyncServer({
        keyhive: true,
        syncServers: { subduction: STAGING },
      }).ark
    ).toBe("0.8");
  });

  it("takes the version it's given over the default", () => {
    expect(resolvePrimarySyncServer({ keyhive: { ark: "0.8" } }).ark).toBe(
      "0.8"
    );
    expect(
      resolvePrimarySyncServer({
        keyhive: { ark: "0.6" },
        syncServers: { subduction: STAGING },
      }).ark
    ).toBe("0.6");
  });

  it("is unset without keyhive", () => {
    expect(resolvePrimarySyncServer({}).ark).toBeUndefined();
    expect(arkStack({})).toBeUndefined();
    expect(ark({})).toBeUndefined();
  });

  it("only swaps the stack in on 0.6", () => {
    expect(ark({ keyhive: { ark: "0.8" } })).toBeUndefined();
    expect(ark({ keyhive: { ark: "0.6" } })).toBeDefined();
  });
});

describe("arkAliases", () => {
  const aliases = arkAliases("production");
  const target = (specifier: string) => {
    const alias = aliases.find(({ find }) => (find as RegExp).test(specifier));
    return alias && specifier.replace(alias.find, alias.replacement);
  };

  it("points every package in the stack at its own copy", () => {
    expect(target("@automerge/automerge-repo/slim")).toContain(
      "@automerge+automerge-repo@2.6.0-subduction.48"
    );
    expect(target("@automerge/automerge-subduction/slim")).toContain(
      "@automerge+automerge-subduction@0.16.1"
    );
    expect(target("@keyhive/keyhive/slim")).toContain(
      "@keyhive+keyhive@0.3.0-alpha.1"
    );
    const keyhive = target("@automerge/automerge-repo-keyhive");
    expect(keyhive).toContain(
      "@automerge+automerge-repo-keyhive@0.6.0-alpha.1"
    );
    expect(keyhive?.endsWith("/dist/index.js")).toBe(true);
  });

  it("maps a deep path into a package without exports to its file", () => {
    const wasm = target("@automerge/automerge-repo-keyhive/dist/wasm.js");
    expect(wasm).toContain("@automerge+automerge-repo-keyhive@0.6.0-alpha.1");
    expect(wasm?.endsWith("/dist/wasm.js")).toBe(true);
  });

  it("resolves wasm from next to ARK 0.6", () => {
    expect(arkStack({ keyhive: { ark: "0.6" } })).toContain(
      "@automerge+automerge-repo-keyhive@0.6.0-alpha.1"
    );
  });

  it("keeps the build on patchwork's own automerge", () => {
    expect(target("@automerge/automerge")).toContain(
      "@automerge+automerge@3.5.0"
    );
    expect(target("@automerge/automerge/slim")).toContain(
      "@automerge+automerge@3.5.0"
    );
  });

  it("leaves everything outside the stack alone", () => {
    expect(target("@automerge/automerge-repo-react-hooks")).toBeUndefined();
  });
});
