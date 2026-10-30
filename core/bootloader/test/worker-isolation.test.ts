// The automerge worker never loads package code, so it never walks through a
// package's path provider (spec section 6). Held here statically: nothing the
// worker's resolver is built from imports patchwork-plugins, and the worker
// creates its resolver without `providers`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

describe("automerge worker isolation", () => {
  it("doesn't import patchwork-plugins in the worker or its resolver", () => {
    for (const file of ["automerge-protocol-handler.ts", "resolver.ts"]) {
      expect(source(file), file).not.toMatch(/from\s+["']@inkandswitch\/patchwork-plugins["']/);
    }
  });

  it("creates the worker's resolver without providers", () => {
    const calls = source("automerge-protocol-handler.ts").match(/createResolver\([^;]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/providers/);
  });
});
