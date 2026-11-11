import type {
  DatatypeDescription,
  Plugin,
  PluginDescription,
} from "@inkandswitch/patchwork-plugins";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

function usePlugins<T extends PluginDescription>(type: string): Plugin<T>[] {
  const registry = getRegistry<T>(type);
  const [plugins, setPlugins] = createStore(registry.all());
  const dispose = registry.on("changed", () =>
    setPlugins(reconcile(registry.all()))
  );
  onCleanup(dispose);
  return plugins;
}

export function useDatatypes(): Plugin<DatatypeDescription>[] {
  return usePlugins<DatatypeDescription>("patchwork:datatype");
}
