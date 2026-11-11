import type { BootProgress, BootStage } from "./types.js";

const ELEMENT_ID = "pw-boot-status";
const STYLE_ID = "pw-boot-status-styles";
// A return visit boots in about a second, which is no time to read anything.
const SHOW_AFTER_MS = 1_000;
// Once the first view is up, the rest of the packages get this long to load
// before the box gives up saying so. A package that keeps failing would
// otherwise hold it up for good.
const REST_MAX_MS = 30_000;

const STAGE_TEXT: Record<BootStage, string> = {
  workers: "Starting up",
  identity: "Opening your identity",
  // Boot waits here on the account, which on a first visit waits on the public
  // reader catching up, so it can read the account's datatype.
  "package-list": "Opening your account",
  packages: "Loading packages",
  opening: "Opening",
};

const CSS = `
  #${ELEMENT_ID} {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    max-width: min(22rem, calc(100vw - 24px));
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: #fffc;
    color: #1a1a1a;
    box-shadow: 0 1px 4px #0002;
    font: 0.75rem/1.4 system-ui, sans-serif;
  }
  #${ELEMENT_ID} p {
    margin: 0;
  }
  #${ELEMENT_ID} .pw-boot-status-detail {
    color: #555;
  }
  #${ELEMENT_ID} button {
    margin-top: 0.375rem;
    font: inherit;
  }
  @media (prefers-color-scheme: dark) {
    #${ELEMENT_ID} {
      background: #111c;
      color: #eee;
    }
    #${ELEMENT_ID} .pw-boot-status-detail {
      color: #aaa;
    }
  }
`;

export interface BootStatus {
  /** Boot moved on. */
  update(progress: BootProgress): void;
  /**
   * The first view is on screen, so boot isn't stuck, but packages may still
   * be loading behind it: the box stays up, saying how many, until they all
   * have.
   */
  mounted(): void;
  /** Boot is over, either way: take the box away. */
  done(): void;
}

/**
 * A small box in the corner saying what boot is doing, for a boot slow enough
 * to notice. Once boot as a whole has taken `stuckAfterMs` it says so, with a
 * reload button, and it still goes away if boot gets there after all.
 * `onStuck` is told when that happens. Once the first view is up it goes on
 * counting the packages still loading, and goes when they're all in.
 */
export function showBootStatus(options: {
  stuckAfterMs?: number;
  draw: boolean;
  onStuck?: () => void;
}): BootStatus {
  let progress: BootProgress = { stage: "workers" };
  let element: HTMLElement | undefined;
  // The lines are redrawn on every update; the reload button is kept, since
  // taking it out of the page, even to put it straight back, loses its focus.
  let text: HTMLElement | undefined;
  let reload: HTMLButtonElement | undefined;
  let finished = false;
  let isMounted = false;
  let restTimer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    if (isMounted && !packagesText(progress)) {
      done();
      return;
    }
    if (!element || !text) return;
    if (isMounted) {
      text.replaceChildren(
        line(`${STAGE_TEXT.packages}…`),
        line(packagesText(progress)!, "pw-boot-status-detail")
      );
      element.dataset.stage = progress.stage;
      element.toggleAttribute("data-mounted", true);
      return;
    }
    const lines = [line(`${STAGE_TEXT[progress.stage] ?? progress.stage}…`)];
    // Counted from setup(), not from reaching this stage.
    if (progress.stuck) {
      const seconds = Math.round((options.stuckAfterMs ?? 0) / 1000);
      lines.push(line(`Still not ready after ${seconds}s`));
    }
    const packages = packagesText(progress);
    if (packages) lines.push(line(packages, "pw-boot-status-detail"));
    text.replaceChildren(...lines);
    if (progress.stuck && !reload) {
      reload = document.createElement("button");
      reload.textContent = "Reload";
      reload.addEventListener("click", () => location.reload());
      element.append(reload);
    } else if (!progress.stuck && reload) {
      reload.remove();
      reload = undefined;
    }
    element.dataset.stage = progress.stage;
    element.toggleAttribute("data-stuck", !!progress.stuck);
  };

  const show = () => {
    if (finished || element || !options.draw) return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    element = document.createElement("div");
    element.id = ELEMENT_ID;
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    text = document.createElement("div");
    element.append(text);
    (document.body ?? document.documentElement).appendChild(element);
    render();
  };

  const showTimer = setTimeout(show, SHOW_AFTER_MS);
  const stuckTimer =
    options.stuckAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          console.warn(
            `patchwork: boot hasn't finished after ${options.stuckAfterMs}ms; it's at "${progress.stage}"`,
            progress
          );
          options.onStuck?.();
          show();
        }, options.stuckAfterMs);

  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(showTimer);
    clearTimeout(stuckTimer);
    clearTimeout(restTimer);
    element?.remove();
    element = text = reload = undefined;
  };

  return {
    update(next) {
      progress = next;
      render();
    },
    mounted() {
      if (finished || isMounted) return;
      isMounted = true;
      clearTimeout(stuckTimer);
      reload?.remove();
      reload = undefined;
      restTimer = setTimeout(done, REST_MAX_MS);
      render();
    },
    done,
  };
}

function line(text: string, className?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

function packagesText({ packages }: BootProgress): string | undefined {
  if (!packages?.total || packages.loaded >= packages.total) return undefined;
  const count = `Packages: ${packages.loaded} of ${packages.total}`;
  return packages.latest ? `${count} (${packages.latest})` : count;
}
