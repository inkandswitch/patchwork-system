import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import { getImportableUrlFromAutomergeUrl } from "@inkandswitch/patchwork-filesystem";

// ── OS drag-out ─────────────────────────────────────────────────────────────
// A best-effort extension→MIME map so a single dragged `file` doc can be exposed
// as a real OS file via the Chromium `DownloadURL` format. The bytes are served
// (with the doc's stored mime) by the patchwork service worker; the OS keys off
// the filename extension, so this hint only needs to be reasonable. Duplicated
// on purpose for now — a shared DnD package is a later step.
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

function mimeForName(name: string): string | undefined {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext ? EXT_MIME[ext] : undefined;
}

/**
 * Lets a single `file` doc be dragged to the desktop/Finder as a real file.
 * dragstart has to set `DownloadURL` synchronously, so `prefetch` (call it on
 * mouse-down) loads the doc's name and mime ahead of time. If it hasn't
 * arrived by dragstart, the row's name and an extension-derived mime are used,
 * which is good enough — the OS keys off the filename extension anyway.
 */
export function createDragOut(row: {
  repo: Repo;
  url: AutomergeUrl;
  name: string;
  type: string;
}) {
  let meta: { mime: string; filename: string } | null = null;
  let prefetched = false;

  return {
    prefetch() {
      if (prefetched || row.type !== "file") return;
      prefetched = true;
      row.repo
        .find(row.url)
        .then((handle) => {
          const doc = handle?.doc() as
            | { name?: string; extension?: string; mimeType?: string }
            | undefined;
          if (!doc) return;
          const base = String(doc.name ?? row.name ?? "file");
          const ext = doc.extension
            ? `.${String(doc.extension).replace(/^\.+/, "")}`
            : "";
          const filename = ext && !base.endsWith(ext) ? `${base}${ext}` : base;
          const mime = String(
            doc.mimeType || mimeForName(filename) || "application/octet-stream"
          );
          meta = { mime, filename };
        })
        // best effort: without it the drag still works, with a guessed mime
        .catch(() => {});
    },

    /** Served as raw content by the service worker at `/<encoded url>/`. */
    addTo(dataTransfer: DataTransfer) {
      if (row.type !== "file") return;
      const filename = meta?.filename ?? row.name;
      const mime =
        meta?.mime ?? mimeForName(filename) ?? "application/octet-stream";
      try {
        const swUrl = new URL(
          getImportableUrlFromAutomergeUrl(row.url),
          location.origin
        ).href;
        dataTransfer.setData("DownloadURL", `${mime}:${filename}:${swUrl}`);
      } catch {
        // location unavailable in exotic embeds — skip OS export.
      }
    },
  };
}
