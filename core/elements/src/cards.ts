// What `<patchwork-view>` shows in place of a doc it can't show: a sheet with
// a hand-drawn serif heading that says what's wrong in words, and what the
// reader can do about it. Plain DOM, so every host gets them.
import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { packageDetails } from "./package-details.js";
import type { PackageClaims } from "./package-info.js";
import { h, type Child } from "./dom.js";

/** A card on screen. `dispose` stops whatever it's still watching. */
export type Card = { element: HTMLElement; dispose: () => void };

const SVG = "http://www.w3.org/2000/svg";

// the heading's wobble: drawn once per card, all of them the same filter, so
// a duplicate id is harmless
function roughFilter(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "pw-card__defs");
  svg.setAttribute("aria-hidden", "true");
  const filter = document.createElementNS(SVG, "filter");
  filter.setAttribute("id", "pw-card-rough");
  const noise = document.createElementNS(SVG, "feTurbulence");
  noise.setAttribute("type", "fractalNoise");
  noise.setAttribute("baseFrequency", "0.04");
  noise.setAttribute("numOctaves", "2");
  noise.setAttribute("seed", "1");
  const displace = document.createElementNS(SVG, "feDisplacementMap");
  displace.setAttribute("in", "SourceGraphic");
  displace.setAttribute("scale", "1.4");
  filter.append(noise, displace);
  svg.append(filter);
  return svg;
}

function sheet(kind: string, title: string, ...body: Child[]): HTMLElement {
  ensureCardStyles();
  return h(
    "div",
    { class: "pw-card", "data-card": kind },
    roughFilter(),
    h(
      "div",
      { class: "pw-card__sheet" },
      h("h2", { class: "pw-card__rough" }, title),
      ...body
    )
  );
}

const code = (text: string) => h("code", { class: "pw-card__code" }, text);

function button(
  label: string,
  onClick: () => void,
  primary = false
): HTMLButtonElement {
  const b = h(
    "button",
    {
      type: "button",
      class: primary ? "pw-card__button pw-card__button--primary" : "pw-card__button",
    },
    label
  );
  b.addEventListener("click", onClick);
  return b;
}

function link(label: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: "pw-card__link" }, label);
  b.addEventListener("click", onClick);
  return b;
}

const nothing = () => {};

// distinct ids for each card's datalist
let seq = 0;

/** Still looking: a quiet dot, and only once it's been a moment. */
export function findingCard(label?: string): Card {
  ensureCardStyles();
  const element = h(
    "div",
    { class: "pw-card pw-card--finding", "data-card": "finding", role: "status" },
    h("span", { class: "pw-card__dot" }),
    label && h("span", null, label)
  );
  return { element, dispose: nothing };
}

/** A tool that opens anything ("*"), offered rather than opened unasked. */
export type Anything = { id: string; name: string };

/** The package a doc suggests, as the view stands with it. */
export type Suggestion = {
  url: string;
  /** accepted, and on its way */
  loading: boolean;
  /** why the last try didn't work */
  failed?: string;
};

// a package.json is fetched once per url, however often a card is drawn
const claimsCache = new Map<string, Promise<PackageClaims | undefined>>();
function claimsFor(
  url: string,
  read: (url: string) => Promise<PackageClaims | undefined>
): Promise<PackageClaims | undefined> {
  let claims = claimsCache.get(url);
  if (!claims) {
    claims = read(url).catch(() => undefined);
    claimsCache.set(url, claims);
  }
  return claims;
}

/**
 * A doc whose datatype nothing here opens. If the doc names a package that
 * might, offer to load it: that runs code the doc points at, so it takes a
 * click and then a confirm that says so.
 */
export function noToolCard(props: {
  type: string;
  /** a tool-id the view was asked for that isn't registered */
  missingToolId?: string;
  suggestion?: Suggestion;
  anything?: Anything;
  onLoad: (url: string) => void;
  onPeek: (toolId: string) => void;
  /** the realm's repo, to read a suggested package's folder history from */
  repo: Repo;
  readClaims: (url: string) => Promise<PackageClaims | undefined>;
}): Card {
  let disposed = false;
  const what = h(
    "p",
    null,
    "it's a ",
    code(props.type),
    ".",
    h("br"),
    ...(props.missingToolId
      ? ["it asked for the ", code(props.missingToolId), " tool, which isn't available."]
      : ["there's no tool loaded that supports ", code(props.type)])
  );
  const body: Child[] = [what];
  const links: Child[] = [];

  const suggestion = props.suggestion;
  if (!suggestion) {
    body.push(h("p", null, "it'll open here if a package adds a tool for it."));
  } else {
    const named = h("span", null, "a package.");
    const claims = claimsFor(suggestion.url, props.readClaims);
    void claims.then((c) => {
      if (disposed || !c || !(c.title || c.name)) return;
      named.replaceChildren(
        h("strong", { class: "pw-card__pkg" }, c.title ?? c.name),
        c.version ? h("span", { class: "pw-card__pkg-version" }, ` ${c.version}`) : "",
        "."
      );
    });
    body.push(h("p", null, "the doc suggests ", named));
    const load = button(
      suggestion.loading ? "loading…" : suggestion.failed ? "try again" : "load package",
      () => props.onLoad(suggestion.url),
      true
    );
    load.classList.add("pw-card__load");
    load.disabled = suggestion.loading;
    body.push(h("div", { class: "pw-card__actions" }, load));
    if (suggestion.failed) {
      body.push(
        h("p", { class: "pw-card__notice" }, `couldn't load it: ${suggestion.failed}`)
      );
    }
    links.push(...packageDetails({ url: suggestion.url, repo: props.repo, claims }));
  }

  const anything = props.anything;
  if (anything) {
    links.push(
      link(`open doc with ${anything.name.toLowerCase()}`, () =>
        props.onPeek(anything.id)
      )
    );
  }
  if (links.length) body.push(h("p", { class: "pw-card__links" }, ...links));

  return {
    element: sheet("no-tool", "no tool for this", ...body),
    dispose: () => (disposed = true),
  };
}

/**
 * A doc that doesn't say what it is: no `@patchwork` metadata, or none with a
 * type in it. Offers a look at its insides with a tool that opens anything,
 * and a box to give it a type, after which the view opens it with whatever
 * tool that type has.
 */
export function missingTypeCard(props: {
  /** whether it has an `@patchwork` at all, just no type in it */
  hasMetadata: boolean;
  anything?: Anything;
  onPeek: (toolId: string) => void;
  /** types something here opens, to suggest as they type */
  knownTypes: { id: string; name?: string }[];
  onSetType: (type: string) => void;
}): Card {
  const why = props.hasMetadata
    ? h(
        "p",
        null,
        "its ",
        code("@patchwork"),
        " metadata doesn't declare a type, so it's not clear how to open it."
      )
    : h(
        "p",
        null,
        "no ",
        code("@patchwork"),
        " metadata, so nothing here knows what kind of doc it is."
      );

  const listId = `pw-card-types-${++seq}`;
  const input = h("input", {
    class: "pw-card__input",
    type: "text",
    name: "type",
    placeholder: "a type, like essay",
    list: listId,
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "type",
    required: "",
  });
  const list = h("datalist", { id: listId });
  for (const t of props.knownTypes) {
    list.append(h("option", { value: t.id }, t.name && t.name !== t.id ? t.name : undefined));
  }
  const notice = h("p", { class: "pw-card__notice", hidden: "" });
  const form = h(
    "form",
    { class: "pw-card__set-type", hidden: "" },
    h("div", { class: "pw-card__field" }, input, list, h("button", { type: "submit", class: "pw-card__button pw-card__button--primary" }, "save")),
    h(
      "p",
      { class: "pw-card__aside" },
      "set doc's ",
      code("@patchwork.type"),
      "."
    ),
    notice
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const type = input.value.trim();
    if (!type) return;
    try {
      props.onSetType(type);
    } catch (error) {
      notice.hidden = false;
      notice.textContent = `couldn't save it: ${(error as Error)?.message ?? String(error)}`;
    }
  });

  const setType = button("set type", () => {
    const open = form.hidden;
    form.hidden = !open;
    setType.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  });
  setType.setAttribute("aria-expanded", "false");

  const anything = props.anything;
  const actions = h(
    "div",
    { class: "pw-card__actions" },
    anything &&
      button(
        `open with ${anything.name.toLowerCase()}`,
        () => props.onPeek(anything.id),
        true
      ),
    setType
  );

  return {
    element: sheet(
      "missing-type",
      "this doc has no type",
      why,
      anything
        ? undefined // h("p", null, `a look inside might help`)
        : undefined,
      actions,
      form
    ),
    dispose: nothing,
  };
}

// the bits of a subduction repo we read the sync server's connection from;
// absent on repos without one
type Connected = {
  isSubductionConnected?: () => boolean;
  on?: (event: "subduction-connection", cb: (p: { connected: boolean }) => void) => void;
  off?: (event: "subduction-connection", cb: (p: { connected: boolean }) => void) => void;
};

/**
 * A doc the repo couldn't get from anywhere. Says why that tends to happen,
 * and, where the repo knows, colours "sync server" by how the connection to
 * it looks from here. `onReconnect` is called when it comes back.
 */
export function unavailableCard(props: {
  repo: Repo;
  onReconnect: () => void;
}): Card {
  const repo = props.repo as unknown as Connected;
  const cleanups: (() => void)[] = [];
  let server: Child = "sync server";
  if (typeof repo.isSubductionConnected === "function") {
    const read = () => {
      try {
        return repo.isSubductionConnected!();
      } catch {
        return false;
      }
    };
    let connected = read();
    const sync = syncServer(connected);
    server = sync.element;
    // back online: worth asking again
    const update = (now: boolean) => {
      const was = connected;
      connected = now;
      sync.set(now);
      if (now && !was) props.onReconnect();
    };
    if (repo.on && repo.off) {
      const onConnection = (p: { connected: boolean }) => update(p.connected);
      repo.on("subduction-connection", onConnection);
      cleanups.push(() => repo.off!("subduction-connection", onConnection));
    }
    // the event only fires when the connection flips, and a wrapped repo might
    // not pass it on, so read it again every so often too: the colour should
    // never be telling you about a while ago
    const poll = setInterval(() => update(read()), 2000);
    cleanups.push(() => clearInterval(poll));
  }

  const element = sheet(
    "unavailable",
    "can't load this doc",
    h("p", null, "we couldn't get it from anywhere we looked.", h("br"), "that might mean:"),
    h(
      "ul",
      { class: "pw-card__reasons" },
      h("li", null, "the person who sent you the link hasn't given you access yet"),
      h("li", null, "it hasn't finished syncing from their device yet"),
      h("li", null, "something's wrong with the ", server)
    ),
    h("p", null, "we'll keep looking. if it turns up, it'll open right here.")
  );
  return { element, dispose: () => cleanups.forEach((c) => c()) };
}

/**
 * The words "sync server", coloured by the live connection. Hovering says
 * which in a title; a title never shows on a phone, so tapping (or Enter)
 * says it inline too.
 */
function syncServer(connected: boolean) {
  const told = h("span", { class: "pw-card__sync-told", role: "status", hidden: "" });
  const b = h("button", { type: "button", class: "pw-card__sync", "aria-expanded": "false" }, "sync server");
  const set = (now: boolean) => {
    connected = now;
    const word = now ? "connected" : "disconnected";
    b.toggleAttribute("data-connected", now);
    b.title = `sync server: ${word}`;
    b.setAttribute("aria-label", b.title);
    told.textContent = ` (${word})`;
  };
  b.addEventListener("click", () => {
    told.hidden = !told.hidden;
    b.setAttribute("aria-expanded", String(!told.hidden));
  });
  set(connected);
  const element = document.createDocumentFragment();
  element.append(b, told);
  return { element, set };
}

/**
 * A doc that's not shared with this identity: keyhive won't let the view open
 * it. The one thing the reader can do is get their card to the owner, so
 * that's the button. `contactCard` is the card as the phonebook copies it
 * (base64), when there's one to give.
 */
export function notSharedCard(props: { contactCard?: string }): Card {
  let reset: ReturnType<typeof setTimeout> | undefined;
  const body: Child[] = [
    h("p", null, "it's private."),
    h(
      "p",
      null,
      "ask the owner to share it. if you're not in their phonebook, send them your card."
    ),
    h("p", null, "it'll open right here once they do."),
  ];
  const card = props.contactCard;
  if (card) {
    const copy = button(
      "copy my card",
      () => {
        void navigator.clipboard.writeText(card).then(() => {
          copy.textContent = "copied";
          clearTimeout(reset);
          reset = setTimeout(() => (copy.textContent = "copy my card"), 1500);
        });
      },
      true
    );
    body.push(h("div", { class: "pw-card__actions" }, copy));
  }
  return {
    element: sheet("not-shared", "not shared with you yet", ...body),
    dispose: () => clearTimeout(reset),
  };
}

/**
 * A tool that's registered but whose code didn't load: an import that
 * failed, a file that didn't arrive. Says which tool, what went wrong, and
 * lets you ask again.
 */
export function toolFailedCard(props: {
  name: string;
  error: string;
  onRetry: () => void;
}): Card {
  const retry = button(
    "try again",
    () => {
      retry.disabled = true;
      retry.textContent = "trying…";
      props.onRetry();
    },
    true
  );
  return {
    element: sheet(
      "tool-failed",
      `can't load ${props.name}`,
      h("p", null, "the doc is here, but the tool that shows it didn't load."),
      h("p", { class: "pw-card__notice" }, props.error),
      h("div", { class: "pw-card__actions" }, retry)
    ),
    dispose: nothing,
  };
}

/**
 * A url the repo can't read as a doc's address at all. Nothing will make it
 * load, so there's nothing to try again: the link itself needs fixing.
 */
export function invalidUrlCard(props: { url: AutomergeUrl }): Card {
  return {
    element: sheet(
      "invalid-url",
      "this link is broken",
      h(
        "p",
        null,
        "a bit of it got lost or changed on the way here, so it can't point at any doc. maybe a character dropped when it was copied, or the link got cut short."
      ),
      h("p", null, "if someone sent it to you, ask them for the link again."),
      h(
        "p",
        { class: "pw-card__aside" },
        h("code", { class: "pw-card__code pw-card__url" }, props.url)
      )
    ),
    dispose: nothing,
  };
}

const CARD_STYLE_ID = "patchwork-view-card-style";

// One stylesheet for every view's cards, from the `--studio-*` properties,
// with fallbacks for when nothing is themed.
export function ensureCardStyles(): void {
  if (document.getElementById(CARD_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CARD_STYLE_ID;
  style.textContent = CARD_CSS;
  document.head.append(style);
}

const CARD_CSS = /* css */ `
.pw-card {
  --pw-card-ink: var(--studio-line, #1c1a17);
  --pw-card-muted: var(--studio-line-offset-50, color-mix(in oklab, var(--pw-card-ink) 55%, transparent));
  --pw-card-line: var(--studio-chrome-line, var(--pw-card-ink));
  --pw-card-sheet: var(--editor-fill, var(--text-editor-fill, var(--studio-fill, #fffdf5)));
  --pw-card-highlighter: var(--studio-selection-fill, #ffee8888);
  --pw-card-accent: var(--studio-primary-fill, var(--studio-primary, #ff2284));
  --pw-card-accent-ink: var(--studio-primary-line, #fff);
  --pw-card-danger: var(--studio-danger-text, var(--studio-danger, #d33a4c));
  --pw-card-good: var(--studio-added, #40dcba);
  --pw-card-radius: var(--studio-radius-sm, 3px);
  --pw-card-serif: "Fraunces", "Iowan Old Style", Palatino, Georgia, serif;
  --pw-card-mono: var(--studio-family-code, Monaco, ui-monospace, monospace);

  display: grid;
  box-sizing: border-box;
  place-items: center;
  width: 100%;
  height: 100%;
  min-height: 8em;
  overflow: auto;
  padding: 16px;
  color: var(--pw-card-ink);
  font: 14px/1.45 var(--studio-family-ui, var(--studio-family, system-ui, sans-serif));
  /* a doc that's only slow shouldn't flash a card on its way in */
  animation: pw-card-in var(--studio-duration-slow, 0.3s) ease 0.4s both;
}
@keyframes pw-card-in {
  from { opacity: 0; }
}
.pw-card__defs {
  position: absolute;
  width: 0;
  height: 0;
}
.pw-card__sheet {
  box-sizing: border-box;
  max-width: 440px;
  padding: 24px 28px 20px;
  border: 1px solid var(--pw-card-line);
  border-radius: 0.5em;
  background: var(--pw-card-sheet);
  box-shadow: 0 0 10px 2px #66003322;
  text-align: center;
}
.pw-card__sheet p {
  margin: 0 0 12px;
  color: var(--pw-card-muted);
}
.pw-card__rough {
  margin: 0 0 6px;
  font: 400 28px/1.1 var(--pw-card-serif);
  filter: url(#pw-card-rough);
}
.pw-card__code {
  padding: 1px 5px;
  border-radius: var(--pw-card-radius);
  background: var(--pw-card-highlighter);
  color: var(--pw-card-ink);
  font: 11px var(--pw-card-mono);
}
.pw-card__url {
  display: inline-block;
  max-width: 100%;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.pw-card__reasons {
  margin: 0 0 12px;
  padding: 0 0 0 1.2em;
  color: var(--pw-card-muted);
  text-align: left;
}
.pw-card__reasons li + li {
  margin-top: 4px;
}
/* "sync server", in the colour of the connection as it stands. a button, so
   a tap can say which on a phone, where a title never shows */
.pw-card__sync {
  padding: 0;
  border: none;
  background: none;
  color: var(--pw-card-danger);
  font: inherit;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
}
.pw-card__sync[data-connected] {
  color: var(--pw-card-good);
}
.pw-card__sync-told {
  color: var(--pw-card-ink);
}
.pw-card__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 0 0 12px;
}
.pw-card__button {
  padding: 2px 10px;
  border: 1px solid var(--pw-card-line);
  border-radius: 2px;
  background: var(--pw-card-sheet);
  box-shadow: 1px 1px 0 var(--pw-card-line);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.pw-card__button:hover:not(:disabled) {
  translate: -1px -1px;
  box-shadow: 2px 2px 0 var(--pw-card-line);
}
.pw-card__button:active:not(:disabled) {
  translate: 1px 1px;
  box-shadow: none;
}
.pw-card__button:disabled {
  cursor: progress;
  opacity: 0.7;
}
.pw-card__button--primary {
  min-width: 5em;
  background: var(--pw-card-accent);
  color: var(--pw-card-accent-ink);
  font-weight: 600;
}
.pw-card__link {
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.pw-card__aside {
  font-size: 0.9em;
}
.pw-card__sheet .pw-card__aside:last-child,
.pw-card__sheet .pw-card__links:last-child {
  margin-bottom: 0;
}
.pw-card__sheet .pw-card__notice {
  color: var(--pw-card-danger);
}
.pw-card__pkg {
  color: var(--pw-card-ink);
}
.pw-card__pkg-version {
  color: var(--pw-card-muted);
}
/* the card's quieter ways on, one to a line */
.pw-card__links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 0.9em;
}
/* the set-type box, unfolded under its button */
.pw-card__set-type[hidden] {
  display: none;
}
.pw-card__field {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 0 0 8px;
}
.pw-card__input {
  min-width: 0;
  flex: 0 1 16em;
  padding: 2px 8px;
  border: 1px solid var(--pw-card-line);
  border-radius: 2px;
  background: var(--pw-card-sheet);
  color: var(--pw-card-ink);
  font: 13px var(--pw-card-mono);
}
.pw-card__input:focus-visible {
  outline: 2px solid var(--pw-card-accent);
  outline-offset: 1px;
}

/* still finding it: a quiet dot, once it's been a moment */
.pw-card--finding {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--pw-card-muted);
  font-size: 0.9em;
  animation-delay: 1.5s;
}
.pw-card__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pw-card-pulse 2s ease-in-out infinite;
}
@keyframes pw-card-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.6); }
  50% { opacity: 1; transform: scale(1); }
}

/* everything known about a suggested package. a popover, so it sits in the
   top layer, above whatever the view is nested in, but still inherits the
   card's colours */
.pw-pkg[popover] {
  box-sizing: border-box;
  width: min(440px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  margin: auto;
  overflow: auto;
  padding: 18px 22px 16px;
  border: 1px solid var(--pw-card-line);
  border-radius: 0.5em;
  background: var(--pw-card-sheet);
  box-shadow: 0 0 10px 2px #66003322, 3px 3px 0 var(--pw-card-line);
  color: var(--pw-card-ink);
  font: 13px/1.45 var(--studio-family-ui, var(--studio-family, system-ui, sans-serif));
  text-align: left;
}
.pw-pkg::backdrop {
  background: color-mix(in oklab, var(--pw-card-ink) 12%, transparent);
}
.pw-pkg h3 {
  margin: 0;
  font-size: 22px;
}
.pw-pkg h4 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pw-card-muted);
}
.pw-pkg p {
  margin: 0;
}
.pw-pkg__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pw-pkg__close {
  font-size: 20px;
  line-height: 1;
  text-decoration: none;
}
.pw-pkg__section {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--pw-card-line);
  border-radius: var(--pw-card-radius);
}
.pw-pkg__section:last-child {
  margin-bottom: 0;
}
/* the package's own word gets a dashed edge and the highlighter: it's quoted,
   not vouched for */
.pw-pkg__section--claims {
  border-style: dashed;
  background: color-mix(in oklab, var(--pw-card-highlighter) 35%, transparent);
}
.pw-pkg__version {
  color: var(--pw-card-muted);
  font-size: 0.7em;
}
.pw-pkg__tag {
  margin-left: 4px;
  padding: 0 5px;
  border: 1px dashed currentColor;
  border-radius: var(--pw-card-radius);
  font-weight: 400;
  letter-spacing: 0.04em;
}
.pw-pkg__quiet {
  color: var(--pw-card-muted);
}
.pw-pkg__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0 0 8px;
}
.pw-pkg__facts:last-child {
  margin-bottom: 0;
}
.pw-pkg__facts dt {
  color: var(--pw-card-muted);
}
.pw-pkg__facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.pw-pkg__list {
  margin: 4px 0;
  padding: 0 0 0 1.1em;
}
.pw-pkg__heads {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pw-pkg .pw-card__notice {
  margin: 6px 0 0;
  color: var(--pw-card-danger);
}

@media (prefers-reduced-motion: reduce) {
  .pw-card {
    animation-duration: 0.01s;
  }
  .pw-card__dot {
    animation: none;
  }
}
`;
