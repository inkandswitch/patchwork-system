import {EditorView} from "@codemirror/view"
import {HighlightStyle} from "@codemirror/language"
import {tags as t} from "@lezer/highlight"

const bg = "#282a36"
const fg = "#f8f8f2"
const selection = "#44475a"
const comment = "#6272a4"
const cyan = "#8be9fd"
const green = "#50fa7b"
const orange = "#ffb86c"
const pink = "#ff79c6"
const purple = "#bd93f9"
const red = "#ff5555"
const yellow = "#f1fa8c"

export const draculaTheme = EditorView.theme(
	{
		"&": {
			color: fg,
			backgroundColor: bg,
		},
		".cm-content": {
			caretColor: fg,
		},
		".cm-cursor, .cm-dropCursor": {
			borderLeft: `2px solid ${fg}`,
		},
		".cm-selectionBackground, .cm-content ::selection": {
			backgroundColor: selection,
		},
		".cm-activeLine": {
			backgroundColor: "#44475a44",
		},
		".cm-activeLineGutter": {
			backgroundColor: "#44475a44",
		},
		".cm-gutters": {
			userSelect: "none",
			backgroundColor: bg,
			color: comment,
			border: "none",
		},
		".cm-lineNumbers .cm-gutterElement": {
			userSelect: "none",
			color: comment,
			fontSize: "0.8em",
			display: "flex",
			placeItems: "center",
			placeContent: "center",
		},
		".cm-tooltip": {
			backgroundColor: "#21222c",
			color: fg,
		},
		".cm-panels": {
			backgroundColor: "#21222c",
			color: fg,
		},
		".cm-panel.cm-search": {
			backgroundColor: "#21222c",
		},
		".cm-panel.cm-search input": {
			color: fg,
			backgroundColor: bg,
			border: `1px solid ${selection}`,
		},
		".cm-panel.cm-search button": {
			color: fg,
			backgroundColor: bg,
		},
		".cm-panel.cm-search label": {
			color: fg,
		},
		".cm-scroller": {
			fontFamily: "monospace",
			lineHeight: "1.5",
		},
		".cm-matchingBracket": {
			backgroundColor: "#44475a",
			color: `${green} !important`,
		},
	},
	{dark: true},
)

export const draculaHighlightStyle = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment],
		color: comment,
		fontStyle: "italic",
	},
	{tag: [t.docComment], color: comment},
	{tag: t.meta, color: comment},
	{tag: [t.invalid], color: red},
	{tag: [t.operator], color: pink},
	{tag: [t.punctuation], color: fg},
	{tag: [t.bool], color: purple, fontWeight: "bold"},
	{tag: [t.atom, t.special(t.variableName)], color: purple},
	{tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: pink},
	{tag: [t.typeName, t.className], color: cyan, fontStyle: "italic"},
	{tag: [t.typeOperator], color: pink},
	{
		tag: [t.function(t.variableName), t.function(t.propertyName)],
		color: green,
	},
	{tag: t.variableName, color: fg},
	{tag: [t.definition(t.variableName)], color: fg},
	{tag: [t.propertyName], color: green},
	{tag: [t.string], color: yellow},
	{tag: [t.number, t.integer, t.float], color: purple},
	{tag: [t.escape], color: pink},
	{tag: [t.regexp], color: red},
	{tag: [t.special(t.string)], color: yellow},
	{tag: [t.tagName], color: pink},
	{tag: [t.angleBracket], color: fg},
	{tag: [t.attributeName], color: green, fontStyle: "italic"},
	{tag: [t.attributeValue], color: yellow},
	{tag: [t.namespace], color: cyan},
	{tag: [t.strong], fontWeight: "bold"},
	{tag: [t.emphasis], fontStyle: "italic"},
	{tag: [t.heading], color: purple, fontWeight: "bold"},
	{tag: [t.link], color: cyan, textDecoration: "underline"},
	{tag: [t.quote], color: yellow},
	{tag: [t.list], color: fg},
	{tag: [t.inserted], color: green},
	{tag: [t.deleted], color: red},
	{tag: [t.changed], color: orange},
	{tag: [t.contentSeparator], color: fg},
	{tag: t.annotation, color: comment},
])
