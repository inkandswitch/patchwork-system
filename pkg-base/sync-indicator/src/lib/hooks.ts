import { useCallback, useState } from "react";

/**
 * Hook that returns a function to force a component re-render
 */
export function useForceUpdate() {
  const [, setState] = useState(0);
  return useCallback(() => setState((prev) => prev + 1), []);
}
