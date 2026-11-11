import { createEffect, createSignal, on } from "solid-js";

/**
 * The localStorage keys for persisted sidebar state. Defined here, the canonical
 * sidebar-persistence module, and imported wherever sidebar state is read/written
 * (e.g. the isolated document-area root seeds + persists the right-sidebar keys),
 * so the key strings live in exactly one place.
 */
export const SIDEBAR_KEYS = {
  leftCollapsed: "patchwork:leftSidebarCollapsed",
  rightCollapsed: "patchwork:rightSidebarCollapsed",
  leftWidth: "patchwork:leftSidebarWidth",
  rightWidth: "patchwork:rightSidebarWidth",
  contextToolId: "patchwork:contextSidebarToolId",
} as const;

/**
 * DOM event (dispatched on `window`) asking the context (right) sidebar to
 * collapse. The left sidebar is host-owned and collapsed directly, but the
 * right-sidebar collapse state lives inside `DocumentAreaRoot` (so it survives
 * the isolation boundary), so the host signals it out-of-band through this event.
 */
export const COLLAPSE_CONTEXT_SIDEBAR_EVENT =
  "patchwork:collapse-context-sidebar";

/** Default sidebar width (px) when nothing is persisted. */
export const DEFAULT_SIDEBAR_WIDTH = 400;

/**
 * Reads a number from localStorage with a default fallback
 */
export function getStoredNumber(key: string, defaultValue: number): number {
  const stored = localStorage.getItem(key);
  return stored ? parseInt(stored, 10) : defaultValue;
}

/**
 * Reads a boolean from localStorage (returns true if value is "true")
 */
export function getStoredBoolean(key: string): boolean {
  return localStorage.getItem(key) === "true";
}

/**
 * The host-owned LEFT sidebar's collapse and width state, persisted to
 * localStorage. The right (context) sidebar's state is owned by
 * `DocumentAreaRoot`, so it survives inside the isolation boundary.
 */
export function useSidebarState() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = createSignal(
    getStoredBoolean(SIDEBAR_KEYS.leftCollapsed)
  );
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(
    getStoredNumber(SIDEBAR_KEYS.leftWidth, DEFAULT_SIDEBAR_WIDTH)
  );

  createEffect(
    on(isSidebarCollapsed, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.leftCollapsed, String(value));
    })
  );
  createEffect(
    on(leftSidebarWidth, (value) => {
      localStorage.setItem(SIDEBAR_KEYS.leftWidth, String(value));
    })
  );

  return {
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    leftSidebarWidth,
    setLeftSidebarWidth,
  };
}
