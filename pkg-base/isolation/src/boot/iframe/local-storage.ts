/**
 * `localStorage` stub for the sandboxed iframe. Injected into `boot()` and
 * serialized into the srcdoc by ../host/srcdoc.ts (see ./main.ts for why the
 * iframe helpers are defined at module scope but run inside the sandbox).
 */

/**
 * Give the sandboxed iframe a `localStorage`. An opaque-origin iframe throws on
 * any `localStorage` access, which would break tools (and the `debug` package)
 * that read it. We install an in-memory no-op stub — except `getItem("debug")`,
 * which returns `patchwork:*` so debug logging works inside the iframe when the
 * host has it enabled. Only runs if real `localStorage` is unavailable.
 */
export function installLocalStorageStub(): void {
  try {
    void localStorage;
  } catch {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => (key === "debug" ? "patchwork:*" : null),
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        length: 0,
        key: () => null,
      },
    });
  }
}
