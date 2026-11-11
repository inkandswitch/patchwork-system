export const plugins = [
  {
    type: "patchwork:tool",
    id: "add-doc-to-sidebar-button",
    tags: ["titlebar-tool"],
    name: "Add doc to sidebar button",
    icon: "Plus",
    supportedDatatypes: "*",
    load: () => import("./button.js").then(mod => mod.default),
    unlisted: true,
    forTitleBar: true,
  },
];
