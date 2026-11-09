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

  it("counts the account's folders while it finds them", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    vi.advanceTimersByTime(1_000);
    status.update({
      stage: "package-list",
      folders: { found: 12, done: false },
    });
    expect(box()?.textContent).toContain("Your folders: 12 loaded so far");
    status.update({
      stage: "package-list",
      folders: { found: 14, done: true },
    });
    expect(box()?.textContent).not.toContain("folders");
    status.done();
  });

  it("goes on counting the packages still loading once the first view is up", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    status.update({
      stage: "opening",
      packages: { loaded: 4, total: 9, latest: "markdown" },
    });
    vi.advanceTimersByTime(1_000);
    status.mounted();
    expect(box()?.hasAttribute("data-mounted")).toBe(true);
    expect(box()?.textContent).toContain("Loading packages");
    expect(box()?.textContent).toContain("4 of 9 (markdown)");
    status.update({
      stage: "opening",
      packages: { loaded: 8, total: 9, latest: "tldraw" },
    });
    expect(box()?.textContent).toContain("8 of 9 (tldraw)");
    status.update({
      stage: "opening",
      packages: { loaded: 9, total: 9, latest: "chat" },
    });
    expect(box()).toBe(null);
  });

  it("isn't stuck once the first view is up, and gives up on a package that never loads", () => {
    const onStuck = vi.fn();
    const status = showBootStatus({
      draw: true,
      stuckAfterMs: 30_000,
      onStuck,
    });
    status.update({ stage: "opening", packages: { loaded: 4, total: 9 } });
    vi.advanceTimersByTime(2_000);
    status.mounted();
    vi.advanceTimersByTime(28_000);
    expect(onStuck).not.toHaveBeenCalled();
    expect(box()?.querySelector("button")).toBe(null);
    expect(box()?.textContent).toContain("4 of 9");
    vi.advanceTimersByTime(2_000);
    expect(box()).toBe(null);
  });

  it("goes as soon as the first view is up if every package is in", () => {
    const status = showBootStatus({ draw: true, stuckAfterMs: 30_000 });
    status.update({ stage: "opening", packages: { loaded: 9, total: 9 } });
    vi.advanceTimersByTime(1_000);
    status.mounted();
    expect(box()).toBe(null);
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
