/**
 * A Proxy that answers the `owned` members from `overrides` and forwards the
 * rest to `backing`, which may be a getter so the backing can change under a
 * stable proxy. Functions are bound to their owner, so `overrides`' private
 * `#fields` still work and borrowed methods get the right `this`.
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
