import { createSelector, createSignal, Match, Switch } from "solid-js";
import { renaming, setRenaming } from "../state.ts";

export function ItemName(props: {
  name: string | undefined;
  id: string;
  rename: (name: string) => void;
}) {
  const isBeingRenamed = createSelector(renaming);

  // we only rename on blur
  // to avoid introducing codemirror
  // to the sidebar just for this
  // though codemirror will 101% already
  // be loaded in the system
  // so maybe chill?

  const [next, setNext] = createSignal(props.name);
  // set once the edit has been saved or cancelled, so the blur that follows
  // (the input going away) doesn't save it again
  let done = false;
  function finish(save: boolean, input?: HTMLInputElement) {
    if (done) return;
    done = true;
    // saving an untouched name would still write the title everywhere
    const name = next() ?? "";
    if (save && name !== (props.name ?? "")) props.rename(name);
    // hand focus back to the row, or it falls out of the tree entirely
    const row = input?.closest<HTMLElement>('[role="treeitem"]');
    if (isBeingRenamed(props.id)) setRenaming("");
    row?.focus();
  }

  return (
    <Switch>
      <Match when={isBeingRenamed(props.id)}>
        <form
          style="display: contents"
          onsubmit={(event) => {
            event.preventDefault();
            finish(true, event.currentTarget.querySelector("input")!);
          }}
        >
          <input
            ref={(el) => {
              done = false;
              setNext(props.name);
              setTimeout(() => {
                // todo lol be less hacky
                el.focus();
                el.select();
              }, 80);
            }}
            autofocus
            onblur={() => finish(true)}
            onkeydown={(event) => {
              // escape (or emacs's C-g) gives up on the edit
              if (
                event.key == "Escape" ||
                (event.key == "g" && event.ctrlKey)
              ) {
                event.preventDefault();
                event.stopPropagation();
                finish(false, event.currentTarget);
              }
            }}
            class="document-list-item__name"
            value={next()}
            onInput={(event) => setNext(event.target.value)}
          />
        </form>
      </Match>
      <Match when={!isBeingRenamed(props.id)}>
        <span class="document-list-item__name">{props.name}</span>
      </Match>
    </Switch>
  );
}
