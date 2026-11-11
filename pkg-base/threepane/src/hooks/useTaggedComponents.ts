import {
  getRegistry,
  type ToolDescription,
} from "@inkandswitch/patchwork-plugins";
import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

export type TaggedComponent = {
  id: string;
  name: string;
  icon?: string;
};

/**
 * Live, registry-driven list of every `patchwork:component` carrying `tag`
 * (e.g. `"context-tool"` or `"system-tray"`), sorted by name. A component just
 * declares its tag and shows up everywhere that tag is rendered.
 *
 * Reactive to the registry's `"changed"` event, so a late-registering or
 * hot-reloaded plugin appears without a remount. Safe to call from inside the
 * isolated iframe realm too — it mounts the same plugin set as the host (see
 * `registry.start` in `isolation/src/boot/iframe/main.ts`), so each realm
 * resolves its own local, equivalent list.
 */
export function useTaggedComponents(tag: string): Accessor<TaggedComponent[]> {
  const registry = getRegistry<ToolDescription>("patchwork:component");

  const [version, setVersion] = createSignal(0);
  const off = registry.on("changed", () => setVersion((v) => v + 1));
  onCleanup(off);

  return createMemo(() => {
    version();
    return (registry.all?.() ?? [])
      .filter((description) => (description.tags ?? []).includes(tag))
      .map((description) => ({
        id: description.id,
        name: description.name || description.id,
        icon: description.icon,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}
