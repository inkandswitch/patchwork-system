export const plugins = [
  {
    type: "patchwork:tool",
    id: "raw",
    name: "Raw",
    supportedDatatypes: "*",
    async load() {
      const {default: RawEditorTool} = await import("./raw-editor.js")
      return RawEditorTool
    },
  },
]
