declare const __BUILD_ID__: number;

/**
 * The build this bundle came from: the vite plugin's `__BUILD_ID__` define,
 * `Date.now()` at build time, so a later build compares greater. The page and
 * the shared worker are separate bundles of the same build and both carry it,
 * which is how a tab and the worker can tell they've drifted apart after a
 * deploy. Undefined when built without the plugin.
 */
export const buildId: number | undefined =
  typeof __BUILD_ID__ === "number" ? __BUILD_ID__ : undefined;

/** True when `candidate` is a build id from a later build than `own`. */
export function isNewerBuild(
  candidate: unknown,
  own: number | undefined = buildId
): candidate is number {
  return (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    own !== undefined &&
    candidate > own
  );
}
