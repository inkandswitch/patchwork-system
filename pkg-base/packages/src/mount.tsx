import { render } from "solid-js/web";
import { Packages } from "./packages.tsx";
import type { ToolElement, ToolHandle } from "./registry.ts";

// The tool render contract: (handle, element) => cleanup. Solid's render()
// returns its disposer, which is exactly the cleanup Patchwork wants.
export function mount(handle: ToolHandle, element: ToolElement) {
  return render(() => <Packages handle={handle} element={element} />, element);
}
