import type { NewBuildInfo } from "./types.js";

// A small box in the corner saying a newer build is live, with a button to
// reload onto it. It lives in a shadow root so the page's styles can't reach
// it, and there's only ever one: the service worker and the shared worker
// usually both notice the same deploy.

const STYLE = `
:host {
  all: initial;
  position: fixed;
  inset: auto 16px 16px auto;
  z-index: 2147483647;
  --bg: #fcf2f0;
  --fg: #333;
  --border: #333;
  --button-bg: #333;
  --button-fg: #fcf2f0;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #2a2423;
    --fg: #f3ebe9;
    --border: #f3ebe9;
    --button-bg: #f3ebe9;
    --button-fg: #2a2423;
  }
}
.box {
  box-sizing: border-box;
  max-width: min(340px, calc(100vw - 32px));
  padding: 12px 14px;
  background: var(--bg);
  color: var(--fg);
  border: 2px solid var(--border);
  border-radius: 0;
  box-shadow: 4px 4px 0 var(--border);
  font: 14px/1.4 system-ui, sans-serif;
  animation: in 160ms ease-out;
}
@keyframes in {
  from { opacity: 0; transform: translateY(8px); }
}
@media (prefers-reduced-motion: reduce) {
  .box { animation: none; }
}
p { margin: 0 0 10px; }
.buttons { display: flex; gap: 8px; justify-content: flex-end; }
button {
  font: inherit;
  padding: 4px 12px;
  border-radius: 0;
  border: 2px solid var(--border);
  cursor: pointer;
}
.later { background: transparent; color: var(--fg); }
.reload { background: var(--button-bg); color: var(--button-fg); }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
`;

let shown: HTMLElement | undefined;
let dismissedBuild: number | undefined;

export function promptForNewBuild(info: NewBuildInfo): void {
  if (shown?.isConnected) return;
  // "Later" holds until there's a build newer than the one it was said to.
  if (
    dismissedBuild !== undefined &&
    (info.build === undefined || info.build <= dismissedBuild)
  ) {
    return;
  }
  if (!document.body) {
    const retry = () => promptForNewBuild(info);
    document.addEventListener("DOMContentLoaded", retry, { once: true });
    return;
  }

  const host = document.createElement("patchwork-new-build");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="box" role="status">
      <p>Patchwork system core update.</p>
      <div class="buttons">
        <button class="later" type="button">Later</button>
        <button class="reload" type="button">Reload</button>
      </div>
    </div>
  `;
  root.querySelector(".reload")!.addEventListener("click", () => {
    location.reload();
  });
  root.querySelector(".later")!.addEventListener("click", () => {
    dismissedBuild = info.build ?? Infinity;
    host.remove();
  });

  document.body.append(host);
  shown = host;
}
