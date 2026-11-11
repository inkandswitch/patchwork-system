import { type DatatypeImplementation } from "@inkandswitch/patchwork-plugins";

export type MarkdownDoc = {
  content: string;
};

export const MarkdownDatatype: DatatypeImplementation<MarkdownDoc> = {
  init: (doc: MarkdownDoc) => {
    doc.content = "# Untitled";
  },
  getTitle(doc: MarkdownDoc) {
    const content = doc.content;
    const frontmatterRegex = /---\n([\s\S]+?)\n---/;
    const frontmatterMatch = content.match(frontmatterRegex);
    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";

    const titleRegex = /title:\s"(.+?)"/;
    const subtitleRegex = /subtitle:\s"(.+?)"/;

    const titleMatch = frontmatter.match(titleRegex);
    const subtitleMatch = frontmatter.match(subtitleRegex);

    let title = titleMatch ? titleMatch[1] : null;
    const subtitle = subtitleMatch ? subtitleMatch[1] : "";

    // If title not found in frontmatter, find first markdown heading
    if (!title) {
      const titleFallbackRegex = /(^|\n)#\s(.+)/;
      const titleFallbackMatch = content.match(titleFallbackRegex);
      title = titleFallbackMatch ? titleFallbackMatch[2] : "Untitled";
    }

    return `${title}${subtitle && `: ${subtitle}`}`;
  },
};
