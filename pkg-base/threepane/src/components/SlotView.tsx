import { Show } from "solid-js";
import type { ToolSlot } from "../types";

/**
 * The id that identifies a slot regardless of its kind (tool tuple or component
 * string). Discriminate by `Array.isArray`, not `typeof slot === "string"`:
 * Automerge can return a raw-string slot as a `RawString` object rather than a
 * native string, and `typeof` would then misfire to the tuple branch and index
 * `slot[0]` — yielding the id's first character instead of the whole id.
 */
export const slotId = (slot: ToolSlot): string =>
  Array.isArray(slot) ? String(slot[0]) : String(slot);

export function uniqueSlots(slots: ToolSlot[]): ToolSlot[] {
  const seen = new Set<string>();
  return slots.filter((slot) => {
    const id = slotId(slot);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Render one configured tool-lane slot (doctitle / sidebar).
 *
 * A bare string is a `patchwork:component` id, loaded and rendered with no
 * document. A `[toolId, docId]` tuple renders that tool against the doc the
 * tuple itself names — each slot carries its own document.
 *
 * The tuple-vs-string check is a reactive `<Show>` rather than a plain ternary:
 * a slot can flip kind in place (e.g. a migrated `[toolId, docid]` tuple
 * rewritten to a bare component string) while this component stays mounted, and
 * a ternary — evaluated once when the component runs — would freeze on the stale
 * branch and index the string as if it were a tuple. Discriminate by
 * `Array.isArray`, not `typeof`: a raw-string slot can arrive as an Automerge
 * `RawString` object, which `typeof` would wrongly route to the tuple branch.
 */
export function SlotView(props: { slot: ToolSlot }) {
  return (
    <Show
      when={Array.isArray(props.slot) ? props.slot : false}
      fallback={<patchwork-view component={String(props.slot)} />}
    >
      {(tuple) => (
        <patchwork-view doc-url={tuple()[1]} tool-id={tuple()[0]} />
      )}
    </Show>
  );
}
