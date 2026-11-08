import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/registry/registry.js";

describe("PluginRegistry.loadWhenReady", () => {
  const description = (id: string, load: () => Promise<unknown>) =>
    ({ type: "test:when-ready", id, name: id, load }) as any;

  it("waits for a plugin that is not registered yet", async () => {
    const registry = new PluginRegistry<any>();
    const ready = registry.loadWhenReady("late");

    registry.register(description("late", async () => "impl"), "u");

    expect((await ready).module).toBe("impl");
  });

  it("keeps trying when the plugin is re-registered while it loads", async () => {
    const registry = new PluginRegistry<any>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registry.register(
      description("swapped", async () => {
        await gate;
        return "v1";
      }),
      "u1"
    );

    const ready = registry.loadWhenReady("swapped");
    registry.register(description("swapped", async () => "v2"), "u2");
    release();

    expect((await ready).module).toBe("v2");
  });

  it("waits for a registration when the plugin is removed while it loads", async () => {
    const registry = new PluginRegistry<any>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    registry.register(
      description("gone", async () => {
        await gate;
        return "v1";
      }),
      "u1"
    );

    const ready = registry.loadWhenReady("gone");
    registry.remove("gone");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.register(description("gone", async () => "v2"), "u2");

    expect((await ready).module).toBe("v2");
  });
});
