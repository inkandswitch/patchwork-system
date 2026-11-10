// Renders one doc's writers: each package version that wrote to it with how
// many changes, then the newest changes and who made each.
import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { ExplainedWriter } from "./explain.js";
import { createHistory } from "./history.js";

/** A package's `name@version` for its root url, if known yet. */
export type NameOf = (url: string) => string | undefined;

export function writerLabel(writer: ExplainedWriter, key: string | null, nameOf: NameOf): string {
  if (writer === null) return "Unstamped";
  if (writer === "unrecorded") return `pw:${key} (no record)`;
  const { url } = writer;
  if (url.startsWith("site@")) return `site (build ${url.slice("site@".length)})`;
  if (url.startsWith("automerge:")) return nameOf(url) ?? `${url.slice(0, "automerge:".length + 6)}…`;
  return url;
}

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
function ago(seconds: number): string {
  if (!seconds) return "";
  const delta = seconds - Date.now() / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return relative.format(Math.round(delta / size), unit);
  }
  return "just now";
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const titleOf = (writer: ExplainedWriter) => (writer && writer !== "unrecorded" ? writer.url : "");

export type WritersCleanup = (() => void) & {
  /** Draws again, for when a writer's name arrives. */
  redraw: () => void;
};

/**
 * Renders `handle`'s writers into `container` and keeps them current.
 * Returns a cleanup that stops following the doc and empties the container.
 */
export function renderWriters(
  container: HTMLElement,
  handle: DocHandle<unknown>,
  { nameOf, limit = 50 }: { nameOf: NameOf; limit?: number },
): WritersCleanup {
  const history = createHistory({ limit });
  let scheduled = false;
  let stopped = false;

  function draw() {
    scheduled = false;
    if (stopped) return;
    const doc = handle.doc();
    if (!doc) return;
    history.update(doc);

    const writers = el("ol", "pw-writers__list");
    for (const group of history.summary(doc)) {
      const item = el("li", "pw-writers__writer");
      item.title = titleOf(group.writer);
      item.append(
        el("span", "pw-writers__label", writerLabel(group.writer, group.key, nameOf)),
        el("span", "pw-writers__count", plural(group.count, "change")),
        el("span", "pw-writers__time", ago(group.last)),
      );
      writers.append(item);
    }

    const changes = el("ol", "pw-writers__list");
    for (const change of history.recent(doc)) {
      const item = el("li", "pw-writers__change");
      item.title = titleOf(change.writer);
      const head = el("div", "pw-writers__change-head");
      head.append(
        el("span", "pw-writers__label", writerLabel(change.writer, change.key, nameOf)),
        el("span", "pw-writers__time", ago(change.time)),
      );
      item.append(head);
      if (change.message) item.append(el("div", "pw-writers__message", change.message));
      changes.append(item);
    }

    container.replaceChildren(
      el("h3", "pw-writers__heading", "Writers"),
      writers,
      el("h3", "pw-writers__heading", "Recent changes"),
      changes,
    );
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
  return Object.assign(cleanup, { redraw: schedule });
}
