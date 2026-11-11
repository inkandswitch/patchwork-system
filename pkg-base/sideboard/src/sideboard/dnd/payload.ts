import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo/slim";

export type DndPayloadItem = {
  id?: string;
  url: AutomergeUrl;
  name?: string;
  type?: string;
};

export type DndPayload = {
  source: string;
  items: DndPayloadItem[];
};

// MIME types we can extract document drags from, in order of preference
export const DND_DATA_TYPES = [
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
  "text/uri-list",
  "text/plain",
];

export function hasDocumentDrag(dataTransfer: DataTransfer | null) {
  return Boolean(
    dataTransfer &&
      DND_DATA_TYPES.some((type) => dataTransfer.types.includes(type))
  );
}

function urlFromText(text: string): AutomergeUrl | null {
  const trimmed = text.trim();
  if (isValidAutomergeUrl(trimmed)) return trimmed;
  // patchwork web links carry the document id in the fragment: #doc=<documentId>
  const docId = trimmed.match(/#doc=([^&\s]+)/)?.[1];
  if (docId && isValidAutomergeUrl(`automerge:${docId}`)) {
    return `automerge:${docId}` as AutomergeUrl;
  }
  return null;
}

export function getDndPayload(event: DragEvent): DndPayload | null {
  const data = event.dataTransfer;
  if (!data) return null;

  const dndData = data.getData("text/x-patchwork-dnd");
  if (dndData) {
    try {
      const parsed = JSON.parse(dndData);
      if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
        return { source: parsed.source ?? "", items: parsed.items };
      }
    } catch {
      // fall through to the other types
    }
  }

  const urlData = data.getData("text/x-patchwork-urls");
  if (urlData) {
    try {
      const urls: unknown = JSON.parse(urlData);
      const items = (Array.isArray(urls) ? urls : [])
        .filter((url): url is AutomergeUrl => isValidAutomergeUrl(url))
        .map((url) => ({ url }));
      if (items.length > 0) return { source: "", items };
    } catch {
      // fall through to the other types
    }
  }

  const text = data.getData("text/uri-list") || data.getData("text/plain");
  const items = text
    .split(/\r?\n/)
    .map(urlFromText)
    .filter((url): url is AutomergeUrl => url !== null)
    .map((url) => ({ url }));
  if (items.length > 0) return { source: "", items };

  return null;
}
