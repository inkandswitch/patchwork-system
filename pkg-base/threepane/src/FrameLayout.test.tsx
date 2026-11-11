import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { FrameLayout } from "./PatchworkFrame";

// keyhiveAccess reads this optional export at import; an older patchwork lacks it
vi.mock("@inkandswitch/patchwork-elements", () => ({
  hasActiveAccess: undefined,
}));
vi.mock("@inkandswitch/patchwork-plugins", () => ({
  createDocOfDatatype2: vi.fn(),
  getRegistry: vi.fn(),
}));

function mount(isolation: boolean) {
  const [collapsed, setCollapsed] = createSignal(false);
  const sidebarState = {
    isSidebarCollapsed: collapsed,
    setIsSidebarCollapsed: setCollapsed,
    leftSidebarWidth: () => 300,
    setLeftSidebarWidth: () => {},
  };
  const onInterceptOpen = vi.fn();
  const parentOpen = vi.fn();
  const host = document.createElement("div");
  host.addEventListener("patchwork:open-document", parentOpen);
  document.body.append(host);
  const dispose = render(
    () => (
      <FrameLayout
        accountDocUrl={"automerge:account" as any}
        sidebarState={sidebarState as any}
        sidebarResize={{ handleMouseDown: () => {}, handleToggleClick: () => {} }}
        sidebarWidgets={() => []}
        traySlots={() => []}
        configHandle={() => undefined}
        rootFolderUrl={() => undefined}
        widgetsReady={() => false}
        contactUrl={() => undefined}
        moduleSettingsUrl={() => undefined}
        isolation={isolation}
        onInterceptOpen={onInterceptOpen}
      >
        <div />
      </FrameLayout>
    ),
    host
  );
  const clickSettings = () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === "Settings")!
      .click();
  return { setCollapsed, onInterceptOpen, parentOpen, clickSettings, dispose };
}

describe("account bar under isolation", () => {
  it("still goes to the popover after the sidebar collapses and reopens", () => {
    const f = mount(true);
    f.clickSettings();
    expect(f.onInterceptOpen).toHaveBeenCalledTimes(1);

    f.setCollapsed(true);
    f.setCollapsed(false);
    f.clickSettings();
    expect(f.onInterceptOpen).toHaveBeenCalledTimes(2);
    expect(f.parentOpen).not.toHaveBeenCalled();
    f.dispose();
  });

  it("passes through to the selected-doc provider without isolation", () => {
    const f = mount(false);
    f.clickSettings();
    expect(f.onInterceptOpen).not.toHaveBeenCalled();
    expect(f.parentOpen).toHaveBeenCalledTimes(1);
    f.dispose();
  });
});
