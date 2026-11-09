// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showBootStatus } from "../src/boot-status.js";

const box = () => document.getElementById("pw-boot-status");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  box()?.remove();
});

describe("the boot status box", () => {
  it("isn't shown for a boot that's over quickly", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    vi.advanceTimersByTime(500);
    status.done();
    vi.advanceTimersByTime(60_000);
    expect(box()).toBe(null);
  });

  it("says what boot is doing, as it moves on", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    vi.advanceTimersByTime(1_000);
    expect(box()?.textContent).toContain("Starting up");
    status.update({
      stage: "packages",
      packages: { loaded: 3, total: 7, latest: "markdown" },
    });
    expect(box()?.dataset.stage).toBe("packages");
    expect(box()?.textContent).toContain("Loading packages");
    expect(box()?.textContent).toContain("3 of 7 (markdown)");
    status.done();
    expect(box()).toBe(null);
  });

  it("says where boot is stuck, and goes away if it gets there after all", () => {
    let progress = { stage: "package-list" as const, stuck: false };
    const onStuck = vi.fn(() => {
      progress = { ...progress, stuck: true };
      status.update(progress);
    });
    const status = showBootStatus({
      draw: true,
      stuckAfterMs: 30_000,
      onStuck,
    });
    status.update(progress);
    vi.advanceTimersByTime(30_000);
    expect(onStuck).toHaveBeenCalledOnce();
    expect(box()?.hasAttribute("data-stuck")).toBe(true);
    expect(box()?.textContent).toContain("Opening your account…");
    expect(box()?.textContent).toContain("Still not ready after 30s");
    expect(box()?.querySelector("button")?.textContent).toBe("Reload");
    status.done();
    expect(box()).toBe(null);
  });

  it("keeps the reload button, and its focus, as boot moves on", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    status.update({ stage: "packages", stuck: true });
    vi.advanceTimersByTime(1_000);
    const reload = box()!.querySelector("button")!;
    reload.focus();
    status.update({
      stage: "packages",
      stuck: true,
      packages: { loaded: 3, total: 7 },
    });
    expect(box()?.textContent).toContain("3 of 7");
    expect(box()?.querySelector("button")).toBe(reload);
    expect(document.activeElement).toBe(reload);
    status.done();
  });

  it("draws nothing for a site that shows progress itself, but still says it's stuck", () => {
    const onStuck = vi.fn();
    const status = showBootStatus({
      draw: false,
      stuckAfterMs: 30_000,
      onStuck,
    });
    vi.advanceTimersByTime(30_000);
    expect(onStuck).toHaveBeenCalledOnce();
    expect(box()).toBe(null);
    status.done();
  });

  it("is never stuck without a timeout", () => {
    const onStuck = vi.fn();
    const status = showBootStatus({ draw: true, onStuck });
    vi.advanceTimersByTime(10 * 60_000);
    expect(onStuck).not.toHaveBeenCalled();
    expect(box()?.hasAttribute("data-stuck")).toBe(false);
    status.done();
  });
});
