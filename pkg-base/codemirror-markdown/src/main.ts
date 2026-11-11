import type { Extension } from "@codemirror/state";

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "markdown",
    name: "Markdown",
    icon: "FileText",
    async load() {
      const { MarkdownDatatype } = await import("./datatype.js");
      return MarkdownDatatype;
    },
  },
  {
    type: "patchwork:datatype",
    id: "essay",
    name: "Markdown",
    icon: "FileText",
    unlisted: true,
    async load() {
      const { MarkdownDatatype } = await import("./datatype.js");
      return MarkdownDatatype;
    },
  },
  {
    type: "codemirror:extension",
    id: "codemirror-markdown",
    name: "Markdown",
    supportedDatatypes: ["essay", "markdown"],
    async load(): Promise<Extension> {
      const { markdownExtensions } = await import("./extensions/markdown.js");
      return markdownExtensions();
    },
  },
  {
    type: "codemirror:extension",
    id: "codemirror-markdown-links",
    name: "Markdown Clickable Links",
    supportedDatatypes: ["essay", "markdown"],
    async load(): Promise<Extension> {
      const { markdownLinks } = await import("./extensions/links.js");
      return markdownLinks();
    },
  },
  {
    type: "codemirror:extension",
    id: "codemirror-embed",
    name: "Patchwork Embed",
    supportedDatatypes: ["essay", "markdown"],
    async load(): Promise<Extension> {
      const { markdownEmbed } = await import("./extensions/embed.js");
      return markdownEmbed();
    },
  },
];
