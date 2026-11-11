import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { importPackage } from "@inkandswitch/patchwork-filesystem";
import { registerPlugins } from "@inkandswitch/patchwork-plugins";
import type { JSX } from "solid-js";
import {
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { PackageDetails } from "./PackageAbout";
import { readClaims } from "./packageInfo";

/**
 * The cards the main view shows in place of a doc it can't show: the one
 * lattice and knit draw (a sheet with a hand-drawn serif heading), minus the
 * wobble. Each settles the main view the way patchwork-view would, so the
 * sidebar widgets don't sit waiting on a doc that isn't coming.
 */
function Card(props: {
  url: AutomergeUrl;
  title: string;
  children: JSX.Element;
}) {
  let el!: HTMLDivElement;
  onMount(() => {
    el.dispatchEvent(
      new CustomEvent("patchwork:no-tool", {
        bubbles: true,
        composed: true,
        detail: { url: props.url },
      })
    );
  });
  return (
    <div class="doc-card" ref={el}>
      <svg class="doc-card__defs" aria-hidden="true">
        <filter id="doc-card-rough">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.04"
            numOctaves="2"
            seed="1"
          />
          <feDisplacementMap in="SourceGraphic" scale="1.4" />
        </filter>
      </svg>
      <div class="doc-card__sheet">
        <h2 class="doc-card__rough">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

/** Still looking: a quiet dot, and only once it's been a moment. */
export function Finding() {
  return (
    <div class="doc-card doc-card--finding" role="status">
      <span class="doc-card__dot" />
      <span class="doc-card__finding-label">finding this doc…</span>
    </div>
  );
}

/**
 * A doc whose datatype nothing here opens. If the doc names a package that
 * might, offer to load it: that runs code the doc points at, so it takes a
 * click and then a confirm that says so.
 */
export function NoToolCard(props: {
  url: AutomergeUrl;
  type: string;
  suggestion: string | undefined;
  anything: { id: string; name: string } | undefined;
  onPeek: (toolId: string) => void;
  repo: Repo;
}) {
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal<string>();
  // what its package.json says: fetched, never run, so it's read straight away
  const [claims] = createResource(
    () => props.suggestion,
    (url) => readClaims(url).catch(() => undefined)
  );

  async function load(url: string) {
    const ok = window.confirm(
      `Load this package?\n\n` +
        `${url}\n\n` +
        `Its code runs in this page and can read and change your documents. ` +
        `Only load it if you trust where it came from.`
    );
    if (!ok) return;
    setFailed(undefined);
    setLoading(true);
    try {
      const mod = await importPackage(url);
      if (!Array.isArray(mod?.plugins))
        throw new Error("it doesn't export any plugins");
      // once its tool registers, the main view swaps this card for it
      registerPlugins(mod.plugins, url);
    } catch (error) {
      console.error(`couldn't load the package at ${url}`, error);
      setFailed((error as Error)?.message ?? String(error));
    } finally {
      setLoading(false);
    }
  }

  const named = () => {
    const c = claims();
    return c && (c.title || c.name) ? c : undefined;
  };

  return (
    <Card url={props.url} title="no tool for this">
      <p>
        it's a <code class="doc-card__code">{props.type}</code>.
        <br />
        nothing here opens one yet.
      </p>
      <Show
        when={props.suggestion}
        fallback={<p>it'll open here if a package adds a tool for it.</p>}
      >
        {(url) => (
          <>
            <p>
              the doc suggests{" "}
              <Show when={named()} fallback="a package.">
                {(c) => (
                  <>
                    <strong class="pkg-line">{c().title ?? c().name}</strong>
                    <Show when={c().version}>
                      {(v) => <span class="pkg-line__version"> {v()}</span>}
                    </Show>
                    .
                  </>
                )}
              </Show>
            </p>
            <div class="doc-card__actions">
              <button
                type="button"
                class="doc-card__button doc-card__button--primary"
                disabled={loading()}
                onClick={() => void load(url())}
              >
                {loading() ? "loading…" : "load package"}
              </button>
            </div>
            <Show when={failed()}>
              {(why) => (
                <p class="doc-card__notice">couldn't load it: {why()}</p>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.suggestion || props.anything}>
        <p class="doc-card__links">
          <Show when={props.suggestion}>
            {(url) => (
              <PackageDetails
                url={url()}
                repo={props.repo}
                claims={claims()}
                claimsLoading={claims.loading}
              />
            )}
          </Show>
          <Show when={props.anything}>
            {(tool) => (
              <button
                type="button"
                class="doc-card__link"
                onClick={() => props.onPeek(tool().id)}
              >
                open doc with {tool().name.toLowerCase()}
              </button>
            )}
          </Show>
        </p>
      </Show>
    </Card>
  );
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
 * it looks from here.
 */
export function UnavailableCard(props: {
  url: AutomergeUrl;
  repo: Repo;
  onRetry: () => void;
}) {
  const repo = props.repo as unknown as Connected;
  const knowsConnection = typeof repo.isSubductionConnected === "function";
  const [connected, setConnected] = createSignal(
    knowsConnection ? repo.isSubductionConnected!() : undefined
  );
  // back online: worth asking again
  const update = (now: boolean) => {
    const was = connected();
    setConnected(now);
    if (now && was === false) props.onRetry();
  };
  if (knowsConnection && repo.on && repo.off) {
    const onConnection = (p: { connected: boolean }) => update(p.connected);
    repo.on("subduction-connection", onConnection);
    onCleanup(() => repo.off!("subduction-connection", onConnection));
  }
  // the event only fires when the connection flips, and a wrapped repo might
  // not pass it on, so read it again every so often too: the colour should
  // never be telling you about a while ago
  if (knowsConnection) {
    const poll = setInterval(() => update(repo.isSubductionConnected!()), 2000);
    onCleanup(() => clearInterval(poll));
  }

  return (
    <Card url={props.url} title="can't load this doc">
      <p>
        we couldn't get it from anywhere we looked.
        <br />
        that might mean:
      </p>
      <ul class="doc-card__reasons">
        <li>the person who sent you the link hasn't given you access yet</li>
        <li>it hasn't finished syncing from their device yet</li>
        <li>
          something's wrong with the{" "}
          <Show when={connected() !== undefined} fallback="sync server">
            <SyncServer connected={connected()!} />
          </Show>
        </li>
      </ul>
      <p>we'll keep looking. if it turns up, it'll open right here.</p>
    </Card>
  );
}

/**
 * The words "sync server", coloured by the live connection. Hovering says
 * which in a title; a title never shows on a phone, so tapping (or Enter)
 * says it inline too.
 */
function SyncServer(props: { connected: boolean }) {
  const [told, setTold] = createSignal(false);
  const status = () =>
    `sync server: ${props.connected ? "connected" : "disconnected"}`;
  return (
    <>
      <button
        type="button"
        class="doc-card__sync"
        data-connected={props.connected ? "" : undefined}
        title={status()}
        aria-label={status()}
        aria-expanded={told()}
        onClick={() => setTold((t) => !t)}
      >
        sync server
      </button>
      <Show when={told()}>
        <span class="doc-card__sync-told" role="status">
          {" "}
          ({props.connected ? "connected" : "disconnected"})
        </span>
      </Show>
    </>
  );
}

/**
 * A doc that's here but not shared with this identity: keyhive won't let
 * patchwork-view open it, which otherwise leaves the pane blank. The one thing
 * the reader can do is get their card to the owner, so that's the button.
 * `card` is the contact card as the phonebook copies it (base64), when there's
 * one to give.
 */
export function NotSharedCard(props: { url: AutomergeUrl; card?: string }) {
  const [copied, setCopied] = createSignal(false);
  let reset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reset));
  const copy = async () => {
    if (!props.card) return;
    await navigator.clipboard.writeText(props.card);
    setCopied(true);
    clearTimeout(reset);
    reset = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Card url={props.url} title="not shared with you yet">
      <p>found it, but it's private.</p>
      <p>
        ask the owner to share it. if you're not in their phonebook, send them
        your card.
      </p>
      <p>it'll open right here once they do.</p>
      <Show when={props.card}>
        <div class="doc-card__actions">
          <button
            type="button"
            class="doc-card__button doc-card__button--primary"
            onClick={() => void copy()}
          >
            {copied() ? "copied" : "copy my card"}
          </button>
        </div>
      </Show>
    </Card>
  );
}

/**
 * A tool that's registered but whose code didn't load: an import that
 * failed, a file that didn't arrive. patchwork-view only shows its loading dot
 * then, for good, so this says which tool, what went wrong, and lets you ask
 * again.
 */
export function ToolFailedCard(props: {
  url: AutomergeUrl;
  name: string;
  error: string;
  onRetry: () => Promise<void>;
}) {
  const [trying, setTrying] = createSignal(false);
  const retry = async () => {
    setTrying(true);
    try {
      await props.onRetry();
    } finally {
      setTrying(false);
    }
  };
  return (
    <Card url={props.url} title={`can't load ${props.name}`}>
      <p>the doc is here, but the tool that shows it didn't load.</p>
      <p class="doc-card__notice">{props.error}</p>
      <div class="doc-card__actions">
        <button
          type="button"
          class="doc-card__button doc-card__button--primary"
          disabled={trying()}
          onClick={() => void retry()}
        >
          {trying() ? "trying…" : "try again"}
        </button>
      </div>
    </Card>
  );
}

/**
 * A url the repo can't read as a doc's address at all. Nothing will make it
 * load, so there's nothing to try again: the link itself needs fixing.
 */
export function InvalidUrlCard(props: { url: AutomergeUrl }) {
  return (
    <Card url={props.url} title="this link is broken">
      <p>
        a bit of it got lost or changed on the way here, so it can't point at
        any doc. maybe a character dropped when it was copied, or the link got
        cut short.
      </p>
      <p>if someone sent it to you, ask them for the link again.</p>
      <p class="doc-card__aside">
        <code class="doc-card__code doc-card__url">{props.url}</code>
      </p>
    </Card>
  );
}
