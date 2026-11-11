/**
 * The entries of a comma-separated `attribute` on `element` that are also in
 * `allowed`, in the order requested. The host has to ask for a capability and
 * isolation has to allow it, so nothing is bridged by default. Used for
 * shared-providers and shared-tools.
 */
export function resolveGatedAttribute(
  element: HTMLElement,
  attribute: string,
  allowed: readonly string[],
  label: string = attribute
): string[] {
  const requested = (element.getAttribute(attribute) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const granted: string[] = [];
  for (const entry of requested) {
    if (allowed.includes(entry)) {
      granted.push(entry);
    } else {
      console.warn(
        `[patchwork-isolation] ${label}: "${entry}" is not permitted. ` +
          `New entries need independent security analysis before being added.`
      );
    }
  }
  return granted;
}
