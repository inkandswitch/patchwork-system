import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { hasActiveAccess, setPublicAccess } from "../src/keyhive-access.js";

function keyhiveUrl(): AutomergeUrl {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  bytes[31] = 1;
  return stringifyAutomergeUrl(bytes as never);
}

function hiveWithOwnAccess(access: string | undefined) {
  return {
    active: { individual: { id: "me" } },
    accessForDoc: vi.fn(async () => access),
  } as never;
}

afterEach(() => setPublicAccess(undefined));

describe("hasActiveAccess on ARK 0.8", () => {
  it("opens a doc shared with the identity, without asking the reader", async () => {
    const isPublic = vi.fn(async () => false);
    setPublicAccess(isPublic);
    expect(await hasActiveAccess(hiveWithOwnAccess("Read"), keyhiveUrl())).toBe(true);
    expect(isPublic).not.toHaveBeenCalled();
  });

  it("opens a doc that isn't shared with the identity but is public", async () => {
    setPublicAccess(async () => true);
    expect(await hasActiveAccess(hiveWithOwnAccess(undefined), keyhiveUrl())).toBe(true);
  });

  it("doesn't open a doc that's neither shared nor public", async () => {
    setPublicAccess(async () => false);
    expect(await hasActiveAccess(hiveWithOwnAccess(undefined), keyhiveUrl())).toBe(false);
  });

  it("counts a reader that can't be asked as no", async () => {
    setPublicAccess(async () => {
      throw new Error("reader gone");
    });
    expect(await hasActiveAccess(hiveWithOwnAccess(undefined), keyhiveUrl())).toBe(false);
  });

  it("is only the identity's own access with no public check set", async () => {
    expect(await hasActiveAccess(hiveWithOwnAccess(undefined), keyhiveUrl())).toBe(false);
  });
});

describe("hasActiveAccess on ARK 0.6", () => {
  it("leaves public access to bestAccessForDoc", async () => {
    const isPublic = vi.fn(async () => false);
    setPublicAccess(isPublic);
    const hive = {
      active: { individual: { id: "me" } },
      accessForDoc: vi.fn(async () => undefined),
      bestAccessForDoc: vi.fn(async () => "Read"),
    } as never;
    expect(await hasActiveAccess(hive, keyhiveUrl())).toBe(true);
    expect(isPublic).not.toHaveBeenCalled();
  });
});
