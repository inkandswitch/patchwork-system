import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const bodyFont = (style: "serif" | "sans") =>
  style == "serif"
    ? 'var(--text-editor-family-serif, "Merriweather", serif)'
    : "var(--text-editor-family-sans)";

const markdownStyles = (style: "serif" | "sans"): Record<string, any> => ({
  "&": {},
  "&.cm-editor.cm-focused": {
    outline: "none",
  },

  "&.cm-editor": {
    height: "100%",
    display: "flex",
    alignContent: "center",
    justifyContent: "center",
    overflow: "auto",
  },
  ".cm-scroller": {
    background: "var(--text-editor-fill)",
  },
  ".cm-gutter": {
    background: "transparent",
  },
  ".cm-content": {
    // Justified text makes it look more like the I&S web essay template,
    // but doesn't feel right for most documents.
    // textAlign: "justify",
    textWrap: "pretty",
    fontFamily: bodyFont(style),
    lineHeight: "1.5rem",
    color: "var(--text-editor-line)",
    caretColor: "var(--text-editor-cursor-fill)",
    background: "var(--text-editor-fill)",
    marginBlock: "2rem",
    marginInline: "auto",
    // lol i guess this is the same as box-sizing: content-box
    maxWidth: "calc(var(--max-text-line-width, 100ex) - 2rem)",
    padding: "2rem",
    boxShadow: "none",
    marginBottom: "8em",
    borderRadius: "8px",
  },
  ".cm-content li": {
    marginBottom: 0,
  },
  ".cm-bullet": {
    display: "inline-block",
    width: "1ch",
  },
  ".cm-bullet::before": {
    content: '""',
    display: "inline-block",
    width: "0.4em",
    height: "0.4em",
    borderRadius: "50%",
    background: "currentColor",
    color: "var(--text-editor-line)",
    verticalAlign: "0.15em",
  },
  ".cm-activeLine": {
    backgroundColor: "inherit",
  },

  ".frontmatter, .frontmatter *": {
    fontSize: "14px",
    fontFamily: "var(--text-editor-family-code)",
    color: "var(--syntax-comment, #666)",
    textDecoration: "none",
    fontWeight: "normal",
    lineHeight: "0.8em",
  },

  ".cm-gutters": {
    borderRight: "0",
    border: "0",
    background: "var(--text-editor-gutter-fill)",
  },

  ".cm-comment-gutter": {
    width: "20px",
  },

  ".cm-folded-range-gutter-line-number": {
    display: "none",
  },

  ".cm-folded-range-gutter": {
    background: "var(--text-editor-fill)",
    borderRight: "0px",
    width: "40px",
  },

  ".cm-folded-line-widget": {
    background: "var(--text-editor-fill)",
    border: "0px",
  },

  ".cm-folded-range": {
    background: "var(--text-editor-fill)",
  },

  ".codeblock": {
    background: "orange",
  },
});

const baseHeadingStyles = {
  fontFamily: "var(--studio-heading-family, var(--text-editor-family-sans))",
  fontWeight: "var(--studio-heading-weight, 400)",
  textDecoration: "none",
};

const baseCodeStyles = {
  fontFamily: "var(--text-editor-family-code)",
  fontSize: "1em",
};

const markdownSyntaxHighlighting = (style: "serif" | "sans") =>
  HighlightStyle.define([
    // this is how you ensure that codeblocks are still monospace
    {
      tag: tags.content,
      fontFamily: bodyFont(style),
    },
    {
      tag: tags.heading1,
      ...baseHeadingStyles,
      fontSize: "var(--studio-heading-size-1, 1.5rem)",
      lineHeight: "2rem",
      marginBottom: "1rem",
      marginTop: "2rem",
    },
    {
      tag: tags.heading2,
      ...baseHeadingStyles,
      fontSize: "var(--studio-heading-size-2, 1.5rem)",
      lineHeight: "2rem",
      marginBottom: "1rem",
      marginTop: "2rem",
    },
    {
      tag: tags.heading3,
      ...baseHeadingStyles,
      fontSize: "var(--studio-heading-size-3, 1.25rem)",
      lineHeight: "1.75rem",
      marginBottom: "1rem",
      marginTop: "2rem",
    },
    {
      tag: tags.heading4,
      ...baseHeadingStyles,
      fontSize: "var(--studio-heading-size-4, 1.1rem)",
      marginBottom: "1rem",
      marginTop: "2rem",
    },
    {
      tag: tags.processingInstruction,
      color: "var(--text-editor-line-offset-40)",
    },
    {
      tag: tags.comment,
      color: "var(--syntax-comment, #555)",
      fontFamily: "var(--text-editor-family-code)",
    },
    { tag: tags.quote, fontStyle: "var(--syntax-style-quote, italic)" },
    {
      tag: tags.strong,
      fontWeight: "var(--syntax-weight-strong, bold)",
    },
    {
      tag: tags.emphasis,
      fontStyle: "var(--syntax-style-emphasis, italic)",
    },
    {
      tag: tags.strikethrough,
      textDecoration: "line-through",
    },
    {
      tag: [tags.meta],
      fontWeight: 300,
      color: "var(--syntax-meta, #999)",
      fontFamily: "var(--text-editor-family-sans)",
    },
    { tag: tags.keyword, ...baseCodeStyles, color: "var(--syntax-keyword, #708)" },
    {
      tag: [
        tags.atom,
        tags.bool,
        tags.url,
        tags.contentSeparator,
        tags.labelName,
      ],
      ...baseCodeStyles,
      color: "var(--syntax-atom, var(--studio-secondary))",
    },
    { tag: [tags.literal, tags.inserted], ...baseCodeStyles, color: "var(--syntax-inserted, #164)" },
    { tag: [tags.string, tags.deleted], ...baseCodeStyles, color: "var(--syntax-string, #5f67b5)" },
    {
      tag: [tags.regexp, tags.escape, tags.special(tags.string)],
      ...baseCodeStyles,
      color: "var(--syntax-regexp, #e40)",
    },
    {
      tag: tags.definition(tags.variableName),
      ...baseCodeStyles,
      color: "var(--syntax-definition--variable-name, #00f)",
    },
    { tag: tags.local(tags.variableName), ...baseCodeStyles, color: "var(--syntax-variable-name, #30a)" },
    { tag: [tags.typeName, tags.namespace], ...baseCodeStyles, color: "var(--syntax-type-name, #085)" },
    { tag: tags.className, ...baseCodeStyles, color: "var(--syntax-class-name, #167)" },
    {
      tag: [tags.special(tags.variableName), tags.macroName],
      ...baseCodeStyles,
      color: "var(--syntax-special--variable-name, #256)",
    },
    {
      tag: tags.definition(tags.propertyName),
      ...baseCodeStyles,
      color: "var(--syntax-function--property-name, #00c)",
    },
    { tag: tags.monospace, ...baseCodeStyles },
  ]);

export const theme = (style: "serif" | "sans") => [
  EditorView.theme(markdownStyles(style)),
  syntaxHighlighting(markdownSyntaxHighlighting(style)),
  bullets,
  codeblocks,
];

const bullets = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.build();
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build();
      }
    }
    private build(): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = this.view.state.doc;
      syntaxTree(this.view.state).iterate({
        enter: ({ type, from }) => {
          if (type.name === "ListMark") {
            const char = doc.sliceString(from, from + 1);
            if (["-", "+", "*"].includes(char)) {
              builder.add(
                from,
                from + 1,
                Decoration.replace({ widget: new BulletWidget() })
              );
            }
          }
        },
      });
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    return span;
  }
}
const codeblocks = ViewPlugin.fromClass(
  class BlockquotePlugin {
    decorations: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.buildDeco(view);
    }

    update(update: ViewUpdate) {
      this.buildDeco(update.view);
    }

    buildDeco(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      view.viewportLineBlocks.forEach((line) => {
        const lineObj = view.state.doc.lineAt(line.from);
        const match = /^>.*/g.exec(lineObj.text);
        if (match && match[0]) {
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "codeblock" })
          );
        }
      });

      this.decorations = builder.finish();
    }
  }
);
