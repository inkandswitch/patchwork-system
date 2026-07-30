import { DEFAULT_TITLE, type PatchworkSiteOptions } from "./options.js";
import { ICON_SPECS } from "./icons.js";

/** Builds the generated manifest.webmanifest object — no bundler involved. */
export function buildManifest(
  options: PatchworkSiteOptions
): Record<string, unknown> {
  const title = options.title ?? DEFAULT_TITLE;
  const icons = !options.icons
    ? []
    : ICON_SPECS.filter(
        (spec) =>
          spec.fileName === "apple-touch-icon.png" || spec.manifestPurpose
      ).map((spec) => ({
        src: `/${spec.fileName}`,
        sizes: `${spec.size}x${spec.size}`,
        type: "image/png",
        ...(spec.manifestPurpose ? { purpose: spec.manifestPurpose } : {}),
      }));

  const manifest: Record<string, unknown> = {
    name: title,
    short_name: options.shortName ?? title,
    description: options.description,
    start_url: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: options.backgroundColor ?? "#ffffff",
    theme_color:
      (typeof options.themeColor === "string"
        ? options.themeColor
        : options.themeColor?.light) ??
      options.backgroundColor ??
      "#ffffff",
    icons,
  };

  return { ...manifest, ...options.manifest };
}
