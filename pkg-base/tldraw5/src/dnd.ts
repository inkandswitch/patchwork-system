/**
 * Patchwork drag-and-drop payload parsing.
 *
 * Patchwork document drags (from the folder-tree-view / sideboard and most
 * tools) carry these DataTransfer formats:
 *   - `text/x-patchwork-urls`  — JSON `AutomergeUrl[]` (the detection hook)
 *   - `text/x-patchwork-dnd`   — JSON `{ source, items: [{ id, url, type, name }] }`
 *   - `text/uri-list` / `text/plain` — one Patchwork web link per line
 *
 * Only `text/x-patchwork-urls` is guaranteed; the richer `-dnd` payload, when
 * present, gives us the datatype id and display name without a repo lookup.
 */

import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
} from "@automerge/automerge-repo/slim";

export const PATCHWORK_URLS_MIME = "text/x-patchwork-urls" as const;
export const PATCHWORK_DND_MIME = "text/x-patchwork-dnd" as const;

export interface DroppedDoc {
  url: AutomergeUrl;
  /** Datatype id (from the `-dnd` payload), if known. */
  type?: string;
  /** Display name (from the `-dnd` payload), if known. */
  name?: string;
}

/** True when the drag carries Patchwork document URLs. */
export function isPatchworkDrag(types: readonly string[]): boolean {
  return types.includes(PATCHWORK_URLS_MIME);
}

type DndItem = { url?: unknown; type?: unknown; name?: unknown };
type DndPayload = { items?: DndItem[] };

/** Extract the dropped documents, preferring the richest payload available. */
export function parseDroppedDocs(dt: DataTransfer | null): DroppedDoc[] {
  if (!dt) return [];

  // 1. Structured payload with datatype + name.
  const dnd = dt.getData(PATCHWORK_DND_MIME);
  if (dnd) {
    try {
      const parsed = JSON.parse(dnd) as DndPayload;
      const items = (parsed.items ?? [])
        .map((it): DroppedDoc | null => {
          const url = typeof it.url === "string" ? it.url : undefined;
          if (!url || !isValidAutomergeUrl(url)) return null;
          return {
            url,
            type: typeof it.type === "string" ? it.type : undefined,
            name: typeof it.name === "string" ? it.name : undefined,
          };
        })
        .filter((it): it is DroppedDoc => it !== null);
      if (items.length > 0) return dedupe(items);
    } catch {
      // fall through
    }
  }

  // 2. Bare URL list.
  const urls = dt.getData(PATCHWORK_URLS_MIME);
  if (urls) {
    try {
      const parsed: unknown = JSON.parse(urls);
      const items = (Array.isArray(parsed) ? parsed : [])
        .filter((u): u is AutomergeUrl => typeof u === "string" && isValidAutomergeUrl(u))
        .map((url) => ({ url }));
      if (items.length > 0) return dedupe(items);
    } catch {
      // fall through
    }
  }

  // 3. Plain-text / uri-list fallback (external links, "#doc=<id>" form).
  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) {
    const items = text
      .split(/\r?\n/)
      .map(urlFromText)
      .filter((url): url is AutomergeUrl => url !== null)
      .map((url) => ({ url }));
    if (items.length > 0) return dedupe(items);
  }

  return [];
}

function dedupe(items: DroppedDoc[]): DroppedDoc[] {
  const seen = new Set<string>();
  const out: DroppedDoc[] = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

// Accept `automerge:…` directly, or a Patchwork web link containing
// `#doc=<documentId>` / `?doc=<documentId>`.
function urlFromText(line: string): AutomergeUrl | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (isValidAutomergeUrl(trimmed)) return trimmed;

  const match = trimmed.match(/[#?&]doc=([^&\s]+)/);
  if (match) {
    const raw = decodeURIComponent(match[1]);
    if (isValidAutomergeUrl(raw)) return raw;
    try {
      const url = stringifyAutomergeUrl({ documentId: raw as DocumentId });
      // Round-trip to reject malformed ids.
      parseAutomergeUrl(url);
      return url;
    } catch {
      return null;
    }
  }
  return null;
}
