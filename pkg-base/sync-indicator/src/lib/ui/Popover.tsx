import {
  type JSX,
  createSignal,
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
} from "solid-js";
import { Portal } from "solid-js/web";

interface PopoverContextValue {
  open: () => boolean;
  setOpen: (v: boolean) => void;
  triggerRef: () => HTMLButtonElement | undefined;
  setTriggerRef: (el: HTMLButtonElement) => void;
}

const PopoverContext = createContext<PopoverContextValue>();

export function Popover(props: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: JSX.Element;
}) {
  const [internalOpen, setInternalOpen] = createSignal(false);
  const [triggerRef, setTriggerRef] = createSignal<HTMLButtonElement>();

  const isOpen = () =>
    props.open !== undefined ? props.open : internalOpen();

  const setOpen = (v: boolean) => {
    if (props.open === undefined) {
      setInternalOpen(v);
    }
    props.onOpenChange?.(v);
  };

  return (
    <PopoverContext.Provider
      value={{ open: isOpen, setOpen, triggerRef, setTriggerRef }}
    >
      <div class="sync-popover-wrapper">{props.children}</div>
    </PopoverContext.Provider>
  );
}

export function PopoverTrigger(props: {
  class?: string;
  children: JSX.Element;
}) {
  const ctx = useContext(PopoverContext)!;

  return (
    <button
      ref={(el) => ctx.setTriggerRef(el)}
      type="button"
      class={props.class ?? ""}
      onClick={() => ctx.setOpen(!ctx.open())}
    >
      {props.children}
    </button>
  );
}

export function PopoverContent(props: {
  class?: string;
  children: JSX.Element;
}) {
  const ctx = useContext(PopoverContext)!;
  let contentRef!: HTMLDivElement;
  const [position, setPosition] = createSignal({ top: 0, left: 0 });

  const updatePosition = () => {
    const trigger = ctx.triggerRef();
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 8,
      left: Math.max(0, rect.right - 288),
    });
  };

  createEffect(
    on(ctx.open, (open) => {
      if (!open) return;

      updatePosition();

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (
          contentRef &&
          !contentRef.contains(target) &&
          ctx.triggerRef() &&
          !ctx.triggerRef()!.contains(target)
        ) {
          ctx.setOpen(false);
        }
      };

      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          ctx.setOpen(false);
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);

      onCleanup(() => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleEscape);
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      });
    })
  );

  return (
    <>
      {ctx.open() && (
        <Portal>
          <div
            ref={contentRef}
            class="sync-popover"
            style={{
              top: `${position().top}px`,
              left: `${position().left}px`,
            }}
          >
            {props.children}
          </div>
        </Portal>
      )}
    </>
  );
}
