export const plugins = [
  {
    type: "patchwork:tool",
    id: "codemirror",
    name: "Text Editor",
    supportedDatatypes: ["essay", "markdown"],
    async load() {
      const { mount } = await import("./tool.tsx");
      return mount;
    },
  },
];
