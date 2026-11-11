import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmConfigTray } from "./LlmConfigTray";

vi.mock("@chee/patchwork-llm", () => ({
  ensureConfig: vi.fn(async () => {}),
  dom: vi.fn(() => document.createElement("div")),
  readScopedConfig: vi.fn(),
  readConfig: vi.fn(),
  writeScopeOverride: vi.fn(),
  writeConfig: vi.fn(),
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("model picker position", () => {
  it.each([
    [{ top: 50, bottom: 78, right: 300 }, "86px", "none"],
    [{ top: 650, bottom: 678, right: 300 }, "642px", "translateY(-100%)"],
  ])("keeps the picker in the viewport for button at %o", (rect, top, transform) => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = LlmConfigTray(host);
    const button = host.querySelector("button")!;
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

    button.click();
    const popover = document.querySelector<HTMLElement>(".llm-config-tray-popover")!;
    expect(popover.style.top).toBe(top);
    expect(popover.style.transform).toBe(transform);
    expect(parseFloat(popover.style.maxHeight)).toBeCloseTo(614.4);
    dispose();
  });
});
