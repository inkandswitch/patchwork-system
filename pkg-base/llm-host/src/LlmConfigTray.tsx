import { createSignal, Show } from "solid-js";
import { Portal, render } from "solid-js/web";

// @chee/patchwork-llm is an automerge: package, so importing it means fetching
// a doc through the service worker. The tray mounts on every boot, so it only
// loads the library when the picker opens: a static import made the button
// wait on that fetch, and on webkit closing a tab mid-fetch wedged the worker.
// @ts-ignore — plain-JS library, ships no type declarations
const loadLlm = () => import("@chee/patchwork-llm");

/**
 * The system-tray icon and popover for the LLM model/config picker. Host realm
 * only: it reads and writes the settings doc, which holds the API key.
 *
 * Opened by clicking the icon, or by a `patchwork:open-tool` event with
 * {detail: {component: "llm-config-tray", scope, toolPrompt, toolTools}}, which
 * isolation relays out of a sandbox. Scoped edits go through writeScopeOverride,
 * the global default through writeConfig.
 */

// A per-tool (and optionally per-doc) config scope. No scope = the global default.
type Scope = { toolId: string; docId?: string; toolName?: string; docName?: string };

export function LlmConfigTray(element: HTMLElement) {
  const style = document.createElement("style");
  style.textContent = `
		.llm-config-tray { position: relative; display: inline-flex; align-items: center; }
		.llm-config-tray-button {
			display: inline-flex; align-items: center; gap: var(--studio-space-2xs, 0.25rem);
			height: 1.75rem; padding: 0 var(--studio-space-xs, 0.375rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--studio-chrome-offset-20, var(--studio-fill-offset-20, #d4d4d4));
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-chrome, var(--studio-fill, white));
			color: var(--studio-chrome-line, var(--studio-line, black));
			font: 500 0.75rem/1 var(--studio-family-sans, system-ui, sans-serif); cursor: var(--studio-cursor-pointer, pointer);
		}
		.llm-config-tray-button:hover {
			background: var(--studio-chrome-offset-10, var(--studio-fill-offset-10, #f2f2f2));
		}
		.llm-config-tray-popover {
			position: fixed; z-index: var(--studio-layer-popover, 2147483000); box-sizing: border-box;
			max-width: min(92vw, 520px); max-height: 80vh; overflow: auto;
			background: var(--studio-fill, white); color: var(--studio-line, black);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--studio-fill-offset-20, #d4d4d4);
			border-radius: var(--studio-radius-md, 8px);
			box-shadow: var(--studio-shadow-lg, 0 8px 32px rgba(0,0,0,0.24));
			padding: var(--studio-space-sm, 0.5rem);
			/* Grow out of the tray button. \`scale\`, not \`transform\`: the inline
			   transform flips the popover above the button. Closing is instant. */
			transform-origin: top right;
			transition:
				opacity max(1ms, calc(150ms * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))) var(--studio-ease-out, cubic-bezier(0.23, 1, 0.32, 1)),
				scale max(1ms, calc(150ms * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))) var(--studio-ease-out, cubic-bezier(0.23, 1, 0.32, 1));
		}
		@starting-style {
			.llm-config-tray-popover { opacity: 0; scale: 0.97; }
		}
		.llm-config-tray-popover[data-side="above"] { transform-origin: bottom right; }
		.llm-config-tray-robot { display: block; }
	`;
  element.append(style);

  // Current scope the picker edits (set when opened via event; icon click uses
  // the global default scope).
  const [open, setOpen] = createSignal(false);
  const [scope, setScope] = createSignal<Scope | undefined>();
  const [payload, setPayload] = createSignal<any>({});
  const [pos, setPos] = createSignal<{
    left: number;
    top: number;
    maxHeight: number;
    above: boolean;
  } | null>(null);

  let buttonEl!: HTMLButtonElement;
  let popoverEl: HTMLDivElement | undefined;
  let pickerHost: HTMLDivElement | undefined;
  let currentPicker: any = null;

  function sourceFor(
    sc: Scope | undefined,
    { readScopedConfig, readConfig, writeScopeOverride, writeConfig }: any
  ) {
    if (sc) {
      return {
        read: () => {
          try {
            return readScopedConfig(sc);
          } catch {
            return readConfig();
          }
        },
        write: (next: any) => writeScopeOverride(sc, next),
      };
    }
    return {
      read: () => readConfig(),
      write: (next: any) => writeConfig(next),
    };
  }

  async function mountPicker() {
    const sc = scope();
    const p = payload() || {};
    const llm = await loadLlm();
    await llm.ensureConfig(sc, element);
    if (!pickerHost) return;
    pickerHost.replaceChildren();
    currentPicker = llm.dom({
      source: sourceFor(sc, llm),
      scope: sc,
      toolName: sc?.toolName || p.toolName,
      toolPrompt: p.toolPrompt,
      toolTools: p.toolTools,
    });
    pickerHost.append(currentPicker);
  }

  function positionPopover() {
    const r = buttonEl.getBoundingClientRect();
    const aboveSpace = Math.max(0, r.top - 16);
    const belowSpace = Math.max(0, window.innerHeight - r.bottom - 16);
    const above = aboveSpace >= Math.min(window.innerHeight * 0.8, belowSpace);
    setPos({
      left: Math.max(8, r.right - Math.min(520, window.innerWidth * 0.92)),
      top: above ? r.top - 8 : r.bottom + 8,
      maxHeight: Math.min(window.innerHeight * 0.8, above ? aboveSpace : belowSpace),
      above,
    });
  }

  function openPicker(sc: Partial<Scope> | undefined, p: any) {
    setScope(sc?.toolId ? (sc as Scope) : undefined);
    setPayload(p || {});
    positionPopover();
    setOpen(true);
    queueMicrotask(mountPicker);
  }

  function closePicker() {
    try {
      currentPicker?.destroy?.();
    } catch {}
    currentPicker = null;
    setOpen(false);
  }

  // Open via the `patchwork:open-tool` event (from chat / other tools, incl.
  // relayed across isolation). Match our component id.
  const onOpenTool = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail || detail.component !== "llm-config-tray") return;
    openPicker(detail.scope, detail);
  };
  document.addEventListener("patchwork:open-tool", onOpenTool as EventListener);

  // Close on outside click. Use composedPath() (captured at event time, before
  // the picker re-renders its own DOM on a selection) rather than
  // popoverEl.contains(target): the picker rebuilds its option list when config
  // changes, so the clicked node is often already detached by the time the click
  // bubbles to document — contains() would then wrongly report "outside" and
  // close the popover on every model click.
  const onDocClick = (e: MouseEvent) => {
    if (!open()) return;
    const path = e.composedPath();
    if (
      (popoverEl && path.includes(popoverEl)) ||
      (buttonEl && path.includes(buttonEl))
    ) {
      return; // click was inside the popover or on the tray button
    }
    closePicker();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) closePicker();
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  // Loading on open makes the first click wait on the fetch, so warm it once
  // things are idle (still off the boot path, so the button never waits on
  // it). The button's hover/focus preload covers an idle that never comes.
  const preload = () => void loadLlm().catch(() => {});
  let cancelIdle: () => void;
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(preload);
    cancelIdle = () => cancelIdleCallback(id);
  } else {
    const id = setTimeout(preload, 0);
    cancelIdle = () => clearTimeout(id);
  }

  const dispose = render(
    () => (
      <div class="llm-config-tray">
        <button
          ref={buttonEl}
          class="llm-config-tray-button"
          title="LLM model & config"
          aria-label="LLM model & config"
          onPointerEnter={preload}
          onFocus={preload}
          onClick={(event) => {
            event.stopPropagation();
            if (open()) closePicker();
            else openPicker(undefined, {});
          }}
        >
          <svg
            class="llm-config-tray-robot"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M8 2.75V4.5" />
            <circle cx="8" cy="2" r="0.9" fill="currentColor" stroke="none" />
            <rect x="2.75" y="4.5" width="10.5" height="8.5" rx="2.25" />
            <path d="M1.25 7.75v2.5M14.75 7.75v2.5" />
            <circle cx="6" cy="8.25" r="1" fill="currentColor" stroke="none" />
            <circle cx="10" cy="8.25" r="1" fill="currentColor" stroke="none" />
            <path d="M6.5 10.75h3" />
          </svg>
        </button>
        <Show when={open()}>
          <Portal mount={document.body}>
            <div
              ref={popoverEl}
              class="llm-config-tray-popover"
              data-side={pos()?.above ? "above" : "below"}
              style={{
                left: `${pos()?.left ?? 0}px`,
                top: `${pos()?.top ?? 0}px`,
                "max-height": `${pos()?.maxHeight ?? 0}px`,
                transform: pos()?.above ? "translateY(-100%)" : "none",
                visibility: pos() ? "visible" : "hidden",
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div ref={pickerHost} />
            </div>
          </Portal>
        </Show>
      </div>
    ),
    element
  );

  return () => {
    cancelIdle();
    closePicker();
    dispose();
    style.remove();
    document.removeEventListener(
      "patchwork:open-tool",
      onOpenTool as EventListener
    );
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}
