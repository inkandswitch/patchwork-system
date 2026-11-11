/** Shared types for the iframe-side boot code. */

/**
 * The minimal logger passed into the injected iframe helpers. The real `debug`
 * package isn't available until modules load, so `boot()` provides a small
 * console-backed logger of this shape.
 */
export type IframeLog = (...args: unknown[]) => void;
