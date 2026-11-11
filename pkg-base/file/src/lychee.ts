import {EditorView} from "@codemirror/view"
import {HighlightStyle} from "@codemirror/language"
import {tags as t} from "@lezer/highlight"

export const lycheeTheme = EditorView.theme(
	{
		"&": {
			color: "#000",
			backgroundColor: "#fff",
		},
		".cm-content": {
			caretColor: "#ee046f",
		},
		".cm-cursor, .cm-dropCursor": {
			borderLeft: "2px solid #ee046f",
		},
		".cm-selectionBackground, .cm-content ::selection": {
			backgroundColor: "#e3f6ff",
		},
		".cm-activeLine": {
			backgroundColor: "#086F8A05",
		},
		".cm-activeLineGutter": {
			backgroundColor: "#e3f6ff",
		},
		".cm-gutters": {
			userSelect: "none",
			backgroundColor: "#f9fcff",
			color: "#086F8A",
			border: "none",
		},
		".cm-lineNumbers .cm-gutterElement": {
			userSelect: "none",
			color: "#086F8A77",
			fontSize: "0.8em",
			display: "flex",
			placeItems: "center",
			placeContent: "center",
		},
		".cm-tooltip": {
			backgroundColor: "#f9fcff",
			color: "#086F8A",
		},
		".cm-panels": {
			backgroundColor: "#d5f6ea",
			color: "#334455",
		},
		".cm-panel.cm-search": {
			backgroundColor: "#e3f6ff",
		},
		".cm-scroller": {
			fontFamily: "monospace",
			lineHeight: "1.5",
		},
		".cm-highlightTab": {
			opacity: "0.1",
			fontSize: "0.5em",
		},
		".cm-highlightSpace": {
			opacity: "0.1",
			fontSize: "0.5em",
		},
	},
	{dark: false},
)

export const lycheeHighlightStyle = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment],
		color: "#8899aa",
		fontStyle: "italic",
	},
	{tag: [t.docComment], color: "#253240"},
	{tag: t.meta, color: "#566b7F"},
	{tag: [t.invalid], color: "#ff2a50"},
	{tag: [t.operator, t.punctuation], color: "#086F8A"},
	{tag: [t.bool], color: "#208776", fontWeight: "bold"},
	{
		tag: [t.atom, t.special(t.variableName)],
		color: "#ee046f",
		fontWeight: "bold",
	},
	{tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#810005"},
	{tag: [t.typeName, t.className], color: "#DB4E80", fontWeight: "bold"},
	{tag: [t.typeOperator, t.typeName], color: "#0CADD6"},
	{
		tag: [t.function(t.variableName), t.function(t.propertyName)],
		color: "#3999FF",
	},
	{tag: t.variableName, color: "#ff552a"},
	{tag: [t.definition(t.variableName)], color: "#ff552a"},
	{
		tag: [t.string],
		color: "#208776",
		backgroundColor: "#e1fcfa99",
	},
	{
		tag: [t.number, t.integer, t.float],
		color: "#3999FF",
	},
	{tag: [t.escape], color: "#000"},
	{tag: [t.regexp], color: "#3999FF"},
	{tag: [t.special(t.string)], color: "#208776"},
	{tag: [t.tagName, t.angleBracket], color: "#66629f"},
	{tag: [t.attributeName], color: "#DB4E80", fontStyle: "italic"},
	{tag: [t.namespace], color: "#0CADD6"},
	{tag: [t.strong], fontWeight: "bold"},
	{tag: [t.emphasis], fontStyle: "italic"},
	{tag: [t.heading], color: "#086F8A", fontWeight: "bold"},
	{tag: [t.link], color: "#3999FF", textDecoration: "underline"},
	{tag: [t.quote], color: "#253240"},
	{tag: [t.list], color: "#1d2833"},
	{tag: [t.inserted], color: "#96E8CB"},
	{tag: [t.deleted], color: "#ee046f"},
	{tag: [t.changed], color: "#086F8A"},
	{tag: [t.contentSeparator], color: "#000"},
	{tag: t.annotation, color: "#566b7F"},
])
