// A few lines of DOM building for the cards, which are plain DOM so every
// host gets them whatever it renders with.

export type Child = Node | string | false | null | undefined;

/** A small `createElement`: attributes by name, `undefined` ones left off. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | undefined> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value !== undefined) el.setAttribute(name, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}
