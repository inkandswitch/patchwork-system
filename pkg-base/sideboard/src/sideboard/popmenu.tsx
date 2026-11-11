import {
  createContext,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  Show,
  splitProps,
  useContext,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Chevron } from "./icons.tsx";

export type Anchor = DOMRect | { x: number; y: number };
export type Placement = "bottom-start" | "right-start";

const GUTTER = 2;
const MARGIN = 4;

type MenuContext = {
  closeRoot(): void;
  openSub(): string | null;
  setOpenSub(id: string | null): void;
  depth: number;
};

const Ctx = createContext<MenuContext>();

const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';

function ownItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>(ITEMS)];
}

function position(el: HTMLElement, anchor: Anchor, placement: Placement) {
  const a = "width" in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
  const { width, height } = el.getBoundingClientRect();
  let left = placement === "right-start" ? a.right + GUTTER : a.left;
  let top = placement === "right-start" ? a.top : a.bottom + GUTTER;
  if (left + width > innerWidth - MARGIN) {
    left =
      placement === "right-start"
        ? a.left - width - GUTTER
        : innerWidth - MARGIN - width;
  }
  if (top + height > innerHeight - MARGIN) top = innerHeight - MARGIN - height;
  left = Math.max(MARGIN, left);
  top = Math.max(MARGIN, top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  // Grow out of the point the menu hangs off: the click, or the trigger's
  // corner (whichever side a submenu flipped to).
  const x =
    placement === "right-start" ? (left < a.left ? a.left : a.right) : a.left;
  const y = placement === "right-start" ? a.top : a.bottom;
  el.style.transformOrigin = `${x - left}px ${y - top}px`;
}

/**
 * A floating menu rendered into `document.body`, positioned against `anchor`
 * (a rect, or a pointer position). Closes on Escape and on pointerdown outside
 * any open menu; arrow keys move focus between items, Enter/Space select.
 * Focus the menu itself on open unless `autofocus` is false (the create-new
 * menu focuses its own filter input).
 */
export function Menu(props: {
  anchor: Anchor;
  placement?: Placement;
  class?: string;
  autofocus?: boolean;
  onClose(): void;
  children: JSX.Element;
}) {
  const parent = useContext(Ctx);
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  let el!: HTMLDivElement;

  const ctx: MenuContext = {
    closeRoot: parent?.closeRoot ?? props.onClose,
    openSub,
    setOpenSub,
    depth: (parent?.depth ?? -1) + 1,
  };

  onMount(() => {
    position(el, props.anchor, props.placement ?? "bottom-start");
    if (props.autofocus !== false) el.focus({ preventScroll: true });

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('[role="menu"]')) return;
      ctx.closeRoot();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() =>
      document.removeEventListener("pointerdown", onPointerDown, true)
    );
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.target !== el && !ownItems(el).includes(e.target as HTMLElement)) {
      if (e.key === "Escape") ctx.closeRoot();
      return;
    }
    const items = ownItems(el);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) =>
      items.at(((n % items.length) + items.length) % items.length)?.focus();
    switch (e.key) {
      case "Escape":
        ctx.closeRoot();
        break;
      case "ArrowDown":
        focus(i + 1);
        break;
      case "ArrowUp":
        focus(i < 0 ? -1 : i - 1);
        break;
      case "Home":
        focus(0);
        break;
      case "End":
        focus(-1);
        break;
      case "ArrowLeft":
        if (parent) parent.setOpenSub(null);
        break;
      case "Enter":
      case " ":
        if (i >= 0) items[i].click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <Portal>
      <Ctx.Provider value={ctx}>
        <div
          ref={el}
          role="menu"
          tabIndex={-1}
          class={props.class ?? "popmenu__content"}
          data-expanded=""
          style={{ position: "fixed", "z-index": 2 + ctx.depth }}
          onKeyDown={onKeyDown}
          onFocusIn={(e) =>
            (e.target as HTMLElement).setAttribute("data-highlighted", "")
          }
          onFocusOut={(e) =>
            (e.target as HTMLElement).removeAttribute("data-highlighted")
          }
        >
          {props.children}
        </div>
      </Ctx.Provider>
    </Portal>
  );
}

/** One selectable row. Selecting it runs `onSelect` and closes the whole menu. */
export function MenuItem(
  props: {
    onSelect(): void;
    children: JSX.Element;
  } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "onSelect" | "children">
) {
  const ctx = useContext(Ctx)!;
  const [local, rest] = splitProps(props, [
    "onSelect",
    "children",
    "onPointerMove",
  ]);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      class="popmenu__item"
      {...rest}
      onPointerMove={(e) => {
        e.currentTarget.focus();
        ctx.setOpenSub(null);
        if (typeof local.onPointerMove === "function") local.onPointerMove(e);
      }}
      onClick={() => {
        local.onSelect();
        ctx.closeRoot();
      }}
    >
      {local.children}
    </div>
  );
}

/**
 * A row that opens a nested menu beside it. Opens on hover, click, or
 * ArrowRight; only one submenu per menu is open at a time, and moving over a
 * sibling row closes it.
 */
export function SubMenu(props: { label: JSX.Element; children: JSX.Element }) {
  const ctx = useContext(Ctx)!;
  const id = createUniqueId();
  let trigger!: HTMLDivElement;
  const open = () => ctx.openSub() === id;

  return (
    <>
      <div
        ref={trigger}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open()}
        tabIndex={-1}
        class="popmenu__sub-trigger"
        data-expanded={open() ? "" : undefined}
        onPointerMove={(e) => {
          e.currentTarget.focus();
          ctx.setOpenSub(id);
        }}
        onClick={() => ctx.setOpenSub(id)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ")
            return;
          ctx.setOpenSub(id);
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {props.label}
        <Chevron class="popmenu__sub-chevron" aria-hidden="true" />
      </div>
      <Show when={open()}>
        <Menu
          anchor={trigger.getBoundingClientRect()}
          placement="right-start"
          class="popmenu__sub-content"
          onClose={() => {
            ctx.setOpenSub(null);
            trigger.focus();
          }}
        >
          {props.children}
        </Menu>
      </Show>
    </>
  );
}
