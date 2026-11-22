const LOADING_ELEMENT_ID = "pw-loading";
const LOADING_STYLE_ID = "pw-loading-styles";

const LOADING_CSS = `
  @keyframes pw-loading-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 0.95; }
  }
  #${LOADING_ELEMENT_ID} {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background-color: #fff;
    background-image:
      radial-gradient(ellipse 55% 45% at 28% 35%, #fde4ec, transparent 70%),
      radial-gradient(ellipse 50% 55% at 72% 65%, #e0f0fb, transparent 70%),
      radial-gradient(ellipse 65% 55% at 50% 50%, #f1e6f6, transparent 80%);
    animation: pw-loading-pulse 3.5s ease-in-out infinite;
    transition: opacity 0.6s ease-out;
  }
  @media (prefers-color-scheme: dark) {
    /* The pulse dips to 0.25 opacity, so whatever's behind it shows through.
       Until a theme puts its \`theme\` attribute on <html>, that's the UA's
       white canvas. */
    html:not([theme]),
    html:not([theme]) body {
      background-color: #000;
    }
    #${LOADING_ELEMENT_ID} {
      background-color: #000;
      background-image:
        radial-gradient(ellipse 55% 45% at 28% 35%, #2a1d33, transparent 70%),
        radial-gradient(ellipse 50% 55% at 72% 65%, #1a2738, transparent 70%),
        radial-gradient(ellipse 65% 55% at 50% 50%, #221a2e, transparent 80%);
    }
  }
  #${LOADING_ELEMENT_ID}.pw-loading-fading {
    opacity: 0;
    animation: none;
  }
`;

export function showLoadingAnimation(): void {
  if (!document.getElementById(LOADING_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = LOADING_STYLE_ID;
    style.textContent = LOADING_CSS;
    document.head.appendChild(style);
  }
  if (document.getElementById(LOADING_ELEMENT_ID)) return;
  const el = document.createElement("div");
  el.id = LOADING_ELEMENT_ID;
  document.body.appendChild(el);
}

export function hideLoadingAnimation(): void {
  const el = document.getElementById(LOADING_ELEMENT_ID);
  if (!el) return;
  el.classList.add("pw-loading-fading");
  setTimeout(() => el.remove(), 700);
}

const ERROR_ELEMENT_ID = "pw-error";

const ERROR_CSS = `
  #${ERROR_ELEMENT_ID} {
    position: fixed;
    inset: 0;
    z-index: 1;
    overflow: auto;
    padding: 3rem 1.5rem;
    background: #fff;
    color: #1a1a1a;
    font: 1rem/1.5 system-ui, sans-serif;
  }
  #${ERROR_ELEMENT_ID} > div {
    max-width: 38rem;
    margin: 0 auto;
  }
  #${ERROR_ELEMENT_ID} h1 {
    font-size: 1.25rem;
    margin: 0 0 1rem;
  }
  #${ERROR_ELEMENT_ID} pre {
    padding: 1rem;
    border-radius: 0.5rem;
    background: #f4f0f2;
    overflow: auto;
    white-space: pre-wrap;
    font-size: 0.8125rem;
  }
  @media (prefers-color-scheme: dark) {
    #${ERROR_ELEMENT_ID} {
      background: #111;
      color: #eee;
    }
    #${ERROR_ELEMENT_ID} pre {
      background: #221a2e;
    }
    #${ERROR_ELEMENT_ID} a {
      color: #9cc8f0;
    }
  }
`;

export function showErrorScreen(
  error: unknown,
  options: { contact?: string } = {}
): void {
  hideLoadingAnimation();
  if (document.getElementById(ERROR_ELEMENT_ID)) return;

  const style = document.createElement("style");
  style.textContent = ERROR_CSS;
  document.head.appendChild(style);

  const screen = document.createElement("div");
  screen.id = ERROR_ELEMENT_ID;
  const inner = document.createElement("div");
  screen.appendChild(inner);

  const heading = document.createElement("h1");
  heading.textContent = "Something went wrong starting this site";
  inner.appendChild(heading);

  const detail = document.createElement("pre");
  detail.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  inner.appendChild(detail);

  const advice = document.createElement("p");
  advice.append("Reloading the page may help. If it keeps happening");
  if (options.contact) {
    const link = document.createElement("a");
    link.href = `mailto:${options.contact}`;
    link.textContent = options.contact;
    advice.append(", email ", link);
  }
  advice.append(".");
  inner.appendChild(advice);

  document.body.appendChild(screen);
}
