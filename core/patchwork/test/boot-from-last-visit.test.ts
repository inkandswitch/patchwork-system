import { describe, expect, it } from "vitest";

import { bootFromLastVisit } from "../src/load-order.js";

const storage = (value?: string) => ({ getItem: () => value ?? null });

describe("bootFromLastVisit", () => {
  it("the localStorage override beats the option", () => {
    expect(bootFromLastVisit(false, storage("on"))).toBe(true);
    expect(bootFromLastVisit(true, storage("off"))).toBe(false);
    expect(bootFromLastVisit(true, storage("on"))).toBe(true);
    expect(bootFromLastVisit(false, storage("off"))).toBe(false);
  });

  it("without an override it's the option, off by default", () => {
    expect(bootFromLastVisit(true, storage())).toBe(true);
    expect(bootFromLastVisit(false, storage())).toBe(false);
    expect(bootFromLastVisit(undefined, storage())).toBe(false);
    expect(bootFromLastVisit(true, undefined)).toBe(true);
  });
});
