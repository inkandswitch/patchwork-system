/**
 * Wrap `overrides` in a Proxy that serves the listed `owned` properties from
 * `overrides` itself and transparently forwards every other access to
 * `backing`.
 *
 * `backing` may also be a getter, re-evaluated on every access, so the owner
 * can swap the backing under a stable proxy identity (see
 * `OverlayHandle.swapBackingDocHandle`).
 *
 * Both sides are read with the matching receiver and functions are bound to
 * their owner: owned members run against `overrides` (so its private `#fields`
 * keep working) and forwarded members run against the backing (so the borrowed
 * method gets the right `this`). This lets the overlay classes spell out only
 * the handful of members whose behavior differs and inherit the rest of the
 * large, evolving `Repo` / `DocHandle` surface for free.
 */
export function forwardingProxy<T>(
  overrides: object,
  backing: object | (() => object),
  owned: ReadonlySet<PropertyKey>
): T {
  const currentBacking =
    typeof backing === "function" ? (backing as () => object) : () => backing;
  return new Proxy(overrides, {
    get(target, prop) {
      const source = owned.has(prop) ? target : currentBacking();
      const value = Reflect.get(source, prop, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
    has(target, prop) {
      return owned.has(prop) || prop in currentBacking() || prop in target;
    },
  }) as T;
}
