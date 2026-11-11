export const plugins = [
  {
    type: "patchwork:datatype",
    id: "patternwitch",
    name: "PatternWitch",
    icon: "Grid3x3",
    async load() {
      return (await import("./datatype.js")).PatternWitchDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "patternwitch",
    name: "PatternWitch",
    icon: "Grid3x3",
    supportedDatatypes: ["patternwitch"],
    async load() {
      return (await import("./tool.js")).default;
    },
  },
];
