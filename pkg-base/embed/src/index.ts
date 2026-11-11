// Metadata only: Patchwork evaluates this entry in a worker (no importmap, no
// DOM), so no runtime imports here — the implementation loads lazily.
import type { Tool } from "@inkandswitch/patchwork-plugins";

export const plugins: Tool[] = [
  {
    type: "patchwork:tool",
    id: "embed",
    name: "Embed",
    icon: "PictureInPicture2",
    supportedDatatypes: "*",
    // Load-bearing: keeps "Embed" out of pickers and out of getFallbackTool,
    // which would otherwise recurse (embed frame falling back to itself).
    unlisted: true,
    async load() {
      return (await import("./tool")).default;
    },
  },
];
