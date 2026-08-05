import { DEFAULT_TITLE, type PatchworkSiteOptions } from "./options.js";
import { resolveSyncServers, PRELOAD_WASM_ASSETS } from "./sync-servers.js";
import { ICON_SPECS } from "./icons.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

/** Builds the generated index.html as a plain string — no bundler involved. */
export function buildHtml(options: PatchworkSiteOptions): string {
  const title = options.title ?? DEFAULT_TITLE;
  const lang = (options.html && options.html.lang) || "en";
  const attributes = Object.entries(
    (options.html && options.html.attributes) || {}
  )
    .filter(([name]) => name !== "lang" && /^[a-z][a-z0-9-]*$/i.test(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  const entry = options.entry ?? "/src/main.ts";
  const syncServers = resolveSyncServers(options);

  const head: string[] = [
    `<meta charset="UTF-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="@inkandswitch/patchwork/global.css" />`,
  ];

  if (options.description) {
    head.push(
      `<meta name="description" content="${escapeHtml(options.description)}" />`
    );
  }

  if (options.icons) {
    for (const spec of ICON_SPECS) {
      if (spec.fileName === "apple-touch-icon.png") {
        head.push(
          `<link rel="apple-touch-icon" sizes="${spec.size}x${spec.size}" href="/${spec.fileName}" />`
        );
      } else if (spec.fileName.startsWith("favicon-")) {
        head.push(
          `<link rel="icon" type="image/png" sizes="${spec.size}x${spec.size}" href="/${spec.fileName}" />`
        );
      }
    }
    if (options.icons?.maskIcon) {
      head.push(
        `<link rel="mask-icon" href="${options.icons.maskIcon}" color="${
          options.icons.maskIconColor ?? "#000000"
        }" />`
      );
    }
  }

  if (typeof options.themeColor === "string") {
    head.push(`<meta name="theme-color" content="${options.themeColor}" />`);
  } else if (options.themeColor) {
    head.push(
      `<meta name="theme-color" content="${options.themeColor.light}" media="(prefers-color-scheme: light)" />`,
      `<meta name="theme-color" content="${options.themeColor.dark}" media="(prefers-color-scheme: dark)" />`
    );
  }

  head.push(
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default" />`,
    `<meta name="apple-mobile-web-app-title" content="${escapeHtml(title)}" />`
  );

  if (options.manifest !== false) {
    head.push(`<link rel="manifest" href="/manifest.webmanifest" />`);
  }

  for (const server of syncServers) {
    head.push(`<link rel="preconnect" href="${server}" />`);
  }
  for (const server of syncServers) {
    head.push(`<link rel="dns-prefetch" href="${server}" />`);
  }
  for (const asset of PRELOAD_WASM_ASSETS) {
    head.push(
      `<link rel="preload" href="/${asset}" as="fetch" crossorigin />`
    );
  }

  if (options.html && options.html.extraHead) {
    head.push(options.html.extraHead);
  }

  const body = [
    `<repo-provider><patchwork-view id="root"></patchwork-view></repo-provider>`,
    `<script type="module" src="${entry}"></script>`,
  ];

  if (options.html && options.html.extraBody) {
    body.push(options.html.extraBody);
  }

  return `<!doctype html>
<html lang="${lang}"${attributes}>
${head.join("\n")}
${body.join("\n")}
</html>
`;
}
