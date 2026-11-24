import type { Repo } from "@automerge/automerge-repo/slim";
import { h } from "./dom.js";
import {
  askPlugins,
  isAutomergeUrl,
  pinnedHeads,
  readHistory,
  type PackageClaims,
  type PackageHistory,
  type PluginClaim,
  type Writer,
} from "./package-info.js";

let popovers = 0;

type Settled<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "failed"; error: string };

/**
 * A "see package details" link, and the popover it opens with what's known
 * about a suggested package: what its package.json claims (unverified), and
 * what our own repo shows of its source (url, heads, and which actors have
 * written to its folder doc). Returns the two, link first, to go side by side.
 */
export function packageDetails(props: {
  url: string;
  repo: Repo;
  claims: Promise<PackageClaims | undefined>;
}): [HTMLButtonElement, HTMLDivElement] {
  const id = `pw-pkg-${++popovers}`;
  const automerge = isAutomergeUrl(props.url);
  const pinned = pinnedHeads(props.url);

  let claims: Settled<PackageClaims | undefined> = { state: "loading" };
  // the history is read the first time the popover opens, not before
  let history: Settled<PackageHistory> | undefined;
  // the plugins it reports when it's run, once the reader has asked
  let asking = false;
  let asked: PluginClaim[] | undefined;
  let askFailed: string | undefined;

  const opener = h(
    "button",
    { type: "button", class: "pw-card__link", popovertarget: id },
    "see package details"
  );
  const popover = h("div", { class: "pw-pkg", id, popover: "auto" });

  async function ask() {
    const ok = window.confirm(
      `Listing its plugins runs the package's code in a background worker.\n\n` +
        `${props.url}\n\n` +
        `It can use the network and this site's stored data, including your ` +
        `documents. Only run it if you trust where it came from.\n\n` +
        `Run it?`
    );
    if (!ok) return;
    askFailed = undefined;
    asking = true;
    render();
    try {
      asked = await askPlugins(props.url);
    } catch (error) {
      askFailed = (error as Error)?.message ?? String(error);
    } finally {
      asking = false;
      render();
    }
  }

  popover.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState !== "open" || history || !automerge)
      return;
    history = { state: "loading" };
    render();
    readHistory(props.repo, props.url).then(
      (value) => (history = { state: "ready", value }),
      () => (history = { state: "failed", error: "couldn't get its folder." })
    ).finally(render);
  });

  void props.claims.then((value) => {
    claims = { state: "ready", value };
    render();
  });

  function render() {
    const said = claims.state === "ready" ? claims.value : undefined;
    const heading = h(
      "h3",
      { class: "pw-card__rough" },
      said?.title ?? said?.name ?? "package",
      said?.version && h("span", { class: "pw-pkg__version" }, ` ${said.version}`)
    );
    const close = h(
      "button",
      {
        type: "button",
        class: "pw-card__link pw-pkg__close",
        popovertarget: id,
        popovertargetaction: "hide",
        "aria-label": "close",
      },
      "×"
    );

    const claimed = h(
      "section",
      { class: "pw-pkg__section pw-pkg__section--claims" },
      h("h4", null, "self-reported ", h("span", { class: "pw-pkg__tag" }, "unverified"))
    );
    if (claims.state === "loading") {
      claimed.append(quiet("p", "reading…"));
    } else if (!said && !asked) {
      claimed.append(quiet("p", "no package.json."));
    } else {
      const facts = h("dl", { class: "pw-pkg__facts" });
      fact(facts, "name", said?.name);
      fact(facts, "title", said?.title);
      fact(facts, "author", said?.author);
      fact(facts, "description", said?.description);
      const listed = asked ?? said?.plugins;
      const plugins = h("dd");
      if (listed) {
        plugins.append(pluginList(listed));
      } else if (automerge) {
        const list = h(
          "button",
          { type: "button", class: "pw-card__link" },
          asking ? "listing…" : "list them"
        );
        list.disabled = asking;
        list.addEventListener("click", () => void ask());
        plugins.append(list);
      } else {
        plugins.append(quiet("span", "unknown until loaded"));
      }
      if (askFailed) plugins.append(h("p", { class: "pw-card__notice" }, askFailed));
      facts.append(h("dt", null, "plugins"), plugins);
      claimed.append(facts);
    }

    const source = h("dl", { class: "pw-pkg__facts" });
    source.append(
      h("dt", null, "url"),
      h("dd", null, h("code", { class: "pw-card__code pw-card__url" }, props.url))
    );
    if (pinned.length) {
      source.append(h("dt", null, "pinned"), h("dd", null, heads(pinned)));
    }
    if (automerge && history) {
      if (history.state === "loading") {
        source.append(h("dt", null, "history"), quiet("dd", "reading…"));
      } else if (history.state === "failed") {
        source.append(h("dt", null, "history"), quiet("dd", history.error));
      } else {
        const { value } = history;
        source.append(
          h("dt", null, "heads"),
          h("dd", null, heads(value.heads)),
          h("dt", null, "history"),
          h(
            "dd",
            null,
            `${value.changes} ${value.changes === 1 ? "change" : "changes"}, ` +
              `${value.writers.length} ${value.writers.length === 1 ? "writer" : "writers"}`,
            writerList(value.writers),
            quiet("p", "writers are devices, not people. folder only.")
          )
        );
      }
    }

    popover.replaceChildren(
      h("header", { class: "pw-pkg__header" }, heading, close),
      claimed,
      h("section", { class: "pw-pkg__section" }, h("h4", null, "source"), source)
    );
  }

  render();
  return [opener, popover];
}

function quiet<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  return h(tag, { class: "pw-pkg__quiet" }, text);
}

function fact(list: HTMLElement, label: string, value: string | undefined) {
  if (value) list.append(h("dt", null, label), h("dd", null, value));
}

function pluginList(plugins: PluginClaim[]): Node {
  if (!plugins.length) return h("span", null, "nothing");
  return h(
    "ul",
    { class: "pw-pkg__list" },
    ...plugins.map((p) =>
      h(
        "li",
        null,
        p.name ?? p.id ?? "(unnamed)",
        p.type && quiet("span", ` · ${p.type}`),
        p.supportedDatatypes?.length
          ? quiet("span", ` for ${p.supportedDatatypes.join(", ")}`)
          : null
      )
    )
  );
}

function heads(list: string[]): Node {
  return h(
    "span",
    { class: "pw-pkg__heads" },
    ...list.map((head) =>
      h("code", { class: "pw-card__code", title: head }, head.slice(0, 7))
    )
  );
}

const MOST_WRITERS = 6;

function writerList(writers: Writer[]): Node {
  const more = writers.length - MOST_WRITERS;
  return h(
    "ul",
    { class: "pw-pkg__list" },
    ...writers.slice(0, MOST_WRITERS).map((w) =>
      h(
        "li",
        null,
        h("code", { class: "pw-card__code", title: w.actor }, w.actor.slice(0, 8)),
        ` ${w.changes} ${w.changes === 1 ? "change" : "changes"}`,
        w.last ? quiet("span", ` · ${span(w)}`) : null
      )
    ),
    more > 0 && quiet("li", `and ${more} more`)
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
