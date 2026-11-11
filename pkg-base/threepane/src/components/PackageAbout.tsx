import type { Repo } from "@automerge/automerge-repo/slim";
import {
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  askPlugins,
  isAutomergeUrl,
  pinnedHeads,
  readHistory,
  type PackageClaims,
  type PluginClaim,
  type Writer,
} from "./packageInfo";

let popovers = 0;

/**
 * A "details" link that pops up what's known about a suggested package: what
 * its package.json claims (unverified), and what our own repo shows of its
 * source (url, heads, and which actors have written to its folder doc).
 */
export function PackageDetails(props: {
  url: string;
  repo: Repo;
  claims: PackageClaims | undefined;
  claimsLoading: boolean;
}) {
  const id = `pkg-about-${++popovers}`;
  const automerge = isAutomergeUrl(props.url);
  const pinned = pinnedHeads(props.url);

  // the history is read the first time the popover opens, not before
  const [opened, setOpened] = createSignal(false);
  const [history] = createResource(
    () => (opened() && automerge ? props.url : undefined),
    (url) => readHistory(props.repo, url)
  );

  // the plugins it reports when it's run, once the reader has asked
  const [asking, setAsking] = createSignal(false);
  const [asked, setAsked] = createSignal<PluginClaim[]>();
  const [askFailed, setAskFailed] = createSignal<string>();
  async function ask() {
    const ok = window.confirm(
      `Listing its plugins runs the package's code in a background worker.\n\n` +
        `${props.url}\n\n` +
        `It can use the network and this site's stored data, including your ` +
        `documents. Only run it if you trust where it came from.\n\n` +
        `Run it?`
    );
    if (!ok) return;
    setAskFailed(undefined);
    setAsking(true);
    try {
      setAsked(await askPlugins(props.url));
    } catch (error) {
      setAskFailed((error as Error)?.message ?? String(error));
    } finally {
      setAsking(false);
    }
  }

  let popover!: HTMLDivElement;
  onMount(() => {
    popover.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "open") setOpened(true);
    });
  });

  const heading = () => props.claims?.title ?? props.claims?.name ?? "package";
  const listed = () => asked() ?? props.claims?.plugins;

  return (
    <>
      <button type="button" class="doc-card__link" popovertarget={id}>
        see package details
      </button>
      <div class="pkg-about" id={id} popover="auto" ref={popover}>
        <header class="pkg-about__header">
          <h3 class="doc-card__rough">
            {heading()}
            <Show when={props.claims?.version}>
              {(v) => <span class="pkg-about__version"> {v()}</span>}
            </Show>
          </h3>
          <button
            type="button"
            class="doc-card__link pkg-about__close"
            popovertarget={id}
            popovertargetaction="hide"
            aria-label="close"
          >
            ×
          </button>
        </header>

        <section class="pkg-about__section pkg-about__section--claims">
          <h4>
            self-reported <span class="pkg-about__tag">unverified</span>
          </h4>
          <Switch>
            <Match when={props.claimsLoading}>
              <p class="pkg-about__quiet">reading…</p>
            </Match>
            <Match when={!props.claims && !asked()}>
              <p class="pkg-about__quiet">no package.json.</p>
            </Match>
            <Match when={true}>
              <dl class="pkg-about__facts">
                <Fact label="name" value={props.claims?.name} />
                <Fact label="title" value={props.claims?.title} />
                <Fact label="author" value={props.claims?.author} />
                <Fact label="description" value={props.claims?.description} />
                <dt>plugins</dt>
                <dd>
                  <Show
                    when={listed()}
                    fallback={
                      <Show
                        when={automerge}
                        fallback={
                          <span class="pkg-about__quiet">
                            unknown until loaded
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="doc-card__link"
                          disabled={asking()}
                          onClick={() => void ask()}
                        >
                          {asking() ? "listing…" : "list them"}
                        </button>
                      </Show>
                    }
                  >
                    {(plugins) => <Plugins plugins={plugins()} />}
                  </Show>
                  <Show when={askFailed()}>
                    {(why) => <p class="doc-card__notice">{why()}</p>}
                  </Show>
                </dd>
              </dl>
            </Match>
          </Switch>
        </section>

        <section class="pkg-about__section">
          <h4>source</h4>
          <dl class="pkg-about__facts">
            <dt>url</dt>
            <dd>
              <code class="doc-card__code doc-card__url">{props.url}</code>
            </dd>
            <Show when={pinned.length}>
              <dt>pinned</dt>
              <dd>
                <Heads heads={pinned} />
              </dd>
            </Show>
            <Show when={automerge}>
              <Switch>
                <Match when={history.loading}>
                  <dt>history</dt>
                  <dd class="pkg-about__quiet">reading…</dd>
                </Match>
                <Match when={history.error}>
                  <dt>history</dt>
                  <dd class="pkg-about__quiet">couldn't get its folder.</dd>
                </Match>
                <Match when={history()}>
                  {(h) => (
                    <>
                      <dt>heads</dt>
                      <dd>
                        <Heads heads={h().heads} />
                      </dd>
                      <dt>history</dt>
                      <dd>
                        {h().changes} {h().changes === 1 ? "change" : "changes"}
                        , {h().writers.length}{" "}
                        {h().writers.length === 1 ? "writer" : "writers"}
                        <Writers writers={h().writers} />
                        <p class="pkg-about__quiet">
                          writers are devices, not people. folder only.
                        </p>
                      </dd>
                    </>
                  )}
                </Match>
              </Switch>
            </Show>
          </dl>
        </section>
      </div>
    </>
  );
}

function Fact(props: { label: string; value: string | undefined }) {
  return (
    <Show when={props.value}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </Show>
  );
}

function Plugins(props: { plugins: PluginClaim[] }) {
  return (
    <Show when={props.plugins.length} fallback={<span>nothing</span>}>
      <ul class="pkg-about__list">
        <For each={props.plugins}>
          {(p) => (
            <li>
              {p.name ?? p.id ?? "(unnamed)"}
              <Show when={p.type}>
                {(t) => <span class="pkg-about__quiet"> · {t()}</span>}
              </Show>
              <Show when={p.supportedDatatypes?.length}>
                <span class="pkg-about__quiet">
                  {" "}
                  for {p.supportedDatatypes!.join(", ")}
                </span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function Heads(props: { heads: string[] }) {
  return (
    <span class="pkg-about__heads">
      <For each={props.heads}>
        {(head) => (
          <code class="doc-card__code" title={head}>
            {head.slice(0, 7)}
          </code>
        )}
      </For>
    </span>
  );
}

const MOST_WRITERS = 6;

function Writers(props: { writers: Writer[] }) {
  const more = () => props.writers.length - MOST_WRITERS;
  return (
    <ul class="pkg-about__list">
      <For each={props.writers.slice(0, MOST_WRITERS)}>
        {(w) => (
          <li>
            <code class="doc-card__code" title={w.actor}>
              {w.actor.slice(0, 8)}
            </code>{" "}
            {w.changes} {w.changes === 1 ? "change" : "changes"}
            <Show when={w.last}>
              <span class="pkg-about__quiet"> · {span(w)}</span>
            </Show>
          </li>
        )}
      </For>
      <Show when={more() > 0}>
        <li class="pkg-about__quiet">and {more()} more</li>
      </Show>
    </ul>
  );
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function span(w: Writer): string {
  const last = day(w.last);
  const first = w.first ? day(w.first) : last;
  return first === last ? last : `${first} – ${last}`;
}
