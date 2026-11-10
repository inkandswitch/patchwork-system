// Renders one doc's history: a timeline of sessions coloured by the tool that
// made them, the tools and people who wrote, and each session's changes with
// what they did, where in the tool's source they came from, and who made them.
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { changeDiff, type DiffRow } from "./diff.js";
import type { ExplainedChange, ExplainedPerson, ExplainedWriter } from "./explain.js";
import { createHistory, type Session } from "./history.js";
import type { Origin } from "./sourcemap.js";

/** A package's `name@version` for its root url, if known yet. */
export type NameOf = (url: string) => string | undefined;
/** A contact card, if loaded yet. */
export type Contact = { name: string; color?: string; avatar?: string };
export type ContactOf = (url: string) => Contact | undefined;
/** Where a location in a writer came from in its source, if known yet. */
export type OriginOf = (writer: string, at: string) => Origin | null | undefined;

export type ViewOptions = {
  nameOf: NameOf;
  contactOf?: ContactOf;
  originOf?: OriginOf;
  /** Opens the doc as it was at a change. */
  open?: (hash: string) => void;
  /** Sessions shown before "Show older". */
  pageSize?: number;
};

export function writerLabel(writer: ExplainedWriter, key: string | null, nameOf: NameOf): string {
  if (writer === null) return "Unstamped";
  if (writer === "unrecorded") return `pw:${key} (no record)`;
  const { url } = writer;
  if (url.startsWith("site@")) return `site (build ${url.slice("site@".length)})`;
  if (url.startsWith("automerge:")) return nameOf(url) ?? `${url.slice(0, "automerge:".length + 6)}…`;
  return url;
}

export function personLabel(person: ExplainedPerson, author: string | null, contactOf?: ContactOf): string {
  if (author === null) return "No author";
  if (person === null || person === "unrecorded" || !person.contact) return `Device ${author.slice(0, 8)}`;
  return contactOf?.(person.contact)?.name ?? "Someone";
}

/** A steady hue for a string, so a tool or a person keeps its colour. */
export function hueOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) % 360;
}

const writerColour = (key: string | null) =>
  key === null ? "var(--pw-hist-muted)" : `oklch(0.7 0.14 ${hueOf(key)})`;

const personColour = (person: ExplainedPerson, author: string | null, contactOf?: ContactOf) => {
  if (author === null) return "var(--pw-hist-muted)";
  const contact = person && person !== "unrecorded" && person.contact ? contactOf?.(person.contact) : undefined;
  return contact?.color ?? `oklch(0.62 0.12 ${hueOf(author)})`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** `seconds` since the epoch, relative to now; empty when the writer set no time. */
export function ago(seconds: number): string {
  if (!seconds) return "";
  const delta = seconds - Date.now() / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return relative.format(Math.round(delta / size), unit);
  }
  return "just now";
}

const exact = (seconds: number) => (seconds ? new Date(seconds * 1000).toLocaleString() : "");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const child of children) if (child) node.append(child);
  return node;
}

function button(className: string, label: string, onClick: () => void, ...children: (Node | string)[]) {
  const node = el("button", className, ...children);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", onClick);
  return node;
}

const writerUrl = (writer: ExplainedWriter) => (writer && writer !== "unrecorded" ? writer.url : null);

export type WritersCleanup = (() => void) & {
  /** Draws again, for when a name, contact or source location arrives. */
  redraw: () => void;
  /** Marks the version being viewed, by the hashes of its heads; null for the live doc. */
  mark: (heads: string[] | null) => void;
};

/**
 * Renders `handle`'s history into `container` and keeps it current.
 * Returns a cleanup that stops following the doc and empties the container.
 */
export function renderWriters(
  container: HTMLElement,
  handle: DocHandle<unknown>,
  { nameOf, contactOf, originOf, open, pageSize = 30 }: ViewOptions,
): WritersCleanup {
  const history = createHistory();
  const diffs = new Map<string, DiffRow[]>();
  /** Sessions open, by their newest change's hash. */
  const expanded = new Set<string>();
  const filter = { writer: undefined as string | null | undefined, author: undefined as string | null | undefined };
  let shown = pageSize;
  let marked: Set<string> | null = null;
  let scheduled = false;
  let stopped = false;
  let strip: HTMLElement | undefined;
  let pinnedToEnd = true;

  const diffOf = (change: ExplainedChange) => {
    let rows = diffs.get(change.hash);
    if (!rows) {
      try {
        rows = changeDiff(handle.doc() as never, change);
      } catch {
        rows = [{ path: "", kind: "set", note: "This change couldn't be read." }];
      }
      diffs.set(change.hash, rows);
    }
    return rows;
  };

  const passes = (session: Session) =>
    (filter.writer === undefined || session.key === filter.writer) &&
    (filter.author === undefined || session.author === filter.author);

  function avatar(person: ExplainedPerson, author: string | null, size: "small" | "large") {
    const contact = person && person !== "unrecorded" && person.contact ? contactOf?.(person.contact) : undefined;
    const label = personLabel(person, author, contactOf);
    const node = el("span", `pw-hist__avatar pw-hist__avatar--${size}`);
    node.setAttribute("aria-hidden", "true");
    node.style.setProperty("--pw-hist-person", personColour(person, author, contactOf));
    node.title = person && person !== "unrecorded" ? `${label}\ndevice ${person.device}` : label;
    if (contact?.avatar) {
      const img = document.createElement("img");
      img.src = contact.avatar;
      img.alt = "";
      node.append(img);
    } else {
      node.textContent = author === null ? "" : label.slice(0, 1).toUpperCase();
    }
    return node;
  }

  function diffRow(row: DiffRow) {
    if (!row.path) return el("li", "pw-hist__diff pw-hist__diff--note", row.note ?? "");
    const item = el("li", `pw-hist__diff pw-hist__diff--${row.kind}`, el("code", "pw-hist__path", row.path));
    const values = el("span", "pw-hist__values");
    if (row.before !== undefined) values.append(el("del", "pw-hist__before", row.before));
    if (row.before !== undefined && row.after !== undefined) values.append(el("span", "pw-hist__arrow", "→"));
    if (row.after !== undefined) values.append(el("ins", "pw-hist__after", row.after));
    if (row.note) values.append(el("span", "pw-hist__note", row.note));
    item.append(values);
    return item;
  }

  function location(change: ExplainedChange) {
    if (!change.at) return null;
    const url = writerUrl(change.writer);
    const origin = url ? originOf?.(url, change.at) : undefined;
    const text = origin ? `${origin.source}:${origin.line}` : change.at.replace(/:\d+$/, "");
    const node = el("code", "pw-hist__where", text);
    node.title = origin ? `${origin.name ? `${origin.name} in ` : ""}${origin.source}:${origin.line}:${origin.column}\nbuilt ${change.at}` : change.at;
    return node;
  }

  function changeItem(change: ExplainedChange) {
    const rows = diffOf(change);
    const item = el(
      "li",
      `pw-hist__change${marked?.has(change.hash) ? " pw-hist__change--marked" : ""}`,
      el(
        "div",
        "pw-hist__change-head",
        el("span", "pw-hist__message", change.message ?? (rows.length ? "" : "No visible change")),
        location(change),
        el("time", "pw-hist__time", ago(change.time)),
      ),
      rows.length ? el("ul", "pw-hist__diffs", ...rows.map(diffRow)) : null,
    );
    item.querySelector("time")!.title = exact(change.time);
    if (open) {
      item.append(
        button("pw-hist__open", "Open the doc as it was after this change", () => open(change.hash), "Open this version"),
      );
    }
    return item;
  }

  function touched(session: Session) {
    const paths = new Set<string>();
    for (const change of session.changes.slice(0, 20)) {
      for (const row of diffOf(change)) {
        if (!row.path) continue;
        paths.add(row.path.split(/[.[]/)[0]!);
        if (paths.size > 3) break;
      }
    }
    const list = [...paths];
    return list.length > 3 ? `${list.slice(0, 3).join(", ")} and more` : list.join(", ");
  }

  function sessionCard(session: Session) {
    const id = session.changes[0]!.hash;
    const open_ = expanded.has(id);
    const first = session.changes[0]!;
    const isMarked = !!marked && session.changes.some((c) => marked!.has(c.hash));
    const card = el("li", `pw-hist__session${open_ ? " pw-hist__session--open" : ""}${isMarked ? " pw-hist__session--marked" : ""}`);
    card.id = `pw-hist-${id}`;
    card.style.setProperty("--pw-hist-writer", writerColour(session.key));
    const head = button(
      "pw-hist__session-head",
      `${open_ ? "Hide" : "Show"} ${plural(session.changes.length, "change")}`,
      () => {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        schedule();
      },
      avatar(first.person, first.author, "large"),
      el(
        "span",
        "pw-hist__who",
        el("span", "pw-hist__person", personLabel(first.person, first.author, contactOf)),
        el("span", "pw-hist__tool", writerLabel(first.writer, first.key, nameOf)),
      ),
      el(
        "span",
        "pw-hist__when",
        el("time", "pw-hist__time", ago(session.last)),
        el("span", "pw-hist__count", plural(session.changes.length, "change")),
      ),
    );
    head.setAttribute("aria-expanded", String(open_));
    head.title = writerUrl(first.writer) ?? "";
    card.append(head);
    const summary = touched(session);
    if (!open_ && (summary || first.message)) {
      card.append(el("p", "pw-hist__summary", first.message ?? `Changed ${summary}`));
    }
    if (open_) card.append(el("ol", "pw-hist__changes", ...session.changes.map(changeItem)));
    return card;
  }

  function timeline(sessions: Session[]) {
    const track = el("ol", "pw-hist__track");
    // Oldest on the left, like a timeline; the newest at the end.
    for (const session of [...sessions].reverse()) {
      const id = session.changes[0]!.hash;
      const first = session.changes[0]!;
      const isMarked = !!marked && session.changes.some((c) => marked!.has(c.hash));
      const dim = !passes(session);
      const block = button(
        `pw-hist__block${isMarked ? " pw-hist__block--marked" : ""}${dim ? " pw-hist__block--dim" : ""}${expanded.has(id) ? " pw-hist__block--open" : ""}`,
        `${writerLabel(first.writer, first.key, nameOf)}, ${personLabel(first.person, first.author, contactOf)}, ${plural(session.changes.length, "change")}, ${ago(session.last)}`,
        () => {
          expanded.add(id);
          filter.writer = undefined;
          filter.author = undefined;
          const index = sessions.indexOf(session);
          if (index >= shown) shown = index + 1;
          draw();
          container.querySelector(`#pw-hist-${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" });
        },
      );
      block.style.setProperty("--pw-hist-writer", writerColour(session.key));
      block.style.setProperty("--pw-hist-person", personColour(first.person, first.author, contactOf));
      block.style.setProperty("--pw-hist-size", String(Math.min(4, 1 + Math.log2(session.changes.length))));
      block.title = block.getAttribute("aria-label")!;
      track.append(el("li", "pw-hist__slot", block));
    }
    return track;
  }

  function chip(label: string, count: number, colour: string, active: boolean, onClick: () => void, lead?: Node) {
    const node = button(
      `pw-hist__chip${active ? " pw-hist__chip--active" : ""}`,
      `${active ? "Show everyone's changes" : `Show only ${label}`}`,
      onClick,
      lead ?? el("span", "pw-hist__swatch"),
      el("span", "pw-hist__chip-label", label),
      el("span", "pw-hist__chip-count", String(count)),
    );
    node.style.setProperty("--pw-hist-writer", colour);
    node.setAttribute("aria-pressed", String(active));
    return node;
  }

  function draw() {
    scheduled = false;
    if (stopped) return;
    const doc = handle.doc();
    if (!doc) return;
    history.update(doc as never);
    const sessions = history.sessions(doc as never);
    const scrollLeft = strip ? strip.scrollLeft : 0;
    if (strip) pinnedToEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4;

    strip = el("div", "pw-hist__strip", timeline(sessions));

    const tools = history.summary(doc as never).map((group) =>
      chip(
        writerLabel(group.writer, group.key, nameOf),
        group.count,
        writerColour(group.key),
        filter.writer === group.key,
        () => {
          filter.writer = filter.writer === group.key ? undefined : group.key;
          schedule();
        },
      ),
    );
    const people = history.people(doc as never).map((group) =>
      chip(
        personLabel(group.person, group.author, contactOf),
        group.count,
        personColour(group.person, group.author, contactOf),
        filter.author === group.author,
        () => {
          filter.author = filter.author === group.author ? undefined : group.author;
          schedule();
        },
        avatar(group.person, group.author, "small"),
      ),
    );

    const visible = sessions.filter(passes);
    const list = el("ol", "pw-hist__sessions", ...visible.slice(0, shown).map(sessionCard));
    const more =
      visible.length > shown
        ? button("pw-hist__more", "Show older sessions", () => {
            shown += pageSize;
            schedule();
          }, `Show older (${visible.length - shown} more)`)
        : history.total > sessions.reduce((n, s) => n + s.changes.length, 0)
          ? el("p", "pw-hist__end", `Older changes aren't listed: ${history.total} in all.`)
          : null;

    const parts: (Node | null)[] = [
      strip,
      el(
        "div",
        "pw-hist__legend",
        el("div", "pw-hist__group", el("h3", "pw-hist__heading", "Tools"), el("div", "pw-hist__chips", ...tools)),
        el("div", "pw-hist__group", el("h3", "pw-hist__heading", "People"), el("div", "pw-hist__chips", ...people)),
      ),
      sessions.length === 0
        ? el("p", "pw-hist__empty", "No changes yet.")
        : visible.length === 0
          ? el("p", "pw-hist__empty", "Nothing matches. Choose a highlighted tool or person again to show everything.")
          : list,
      more,
    ];
    container.replaceChildren(...parts.filter((part): part is Node => part !== null));
    strip.scrollLeft = pinnedToEnd ? strip.scrollWidth : scrollLeft;
  }

  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(draw);
  }

  draw();
  handle.on("change", schedule);
  const cleanup = () => {
    stopped = true;
    handle.off("change", schedule);
    container.replaceChildren();
  };
  return Object.assign(cleanup, {
    redraw: schedule,
    mark(heads: string[] | null) {
      marked = heads && heads.length ? new Set(heads) : null;
      if (marked) {
        // Open the session that holds the version being viewed.
        for (const session of history.sessions(handle.doc() as never)) {
          if (session.changes.some((c) => marked!.has(c.hash))) expanded.add(session.changes[0]!.hash);
        }
      }
      schedule();
    },
  });
}
