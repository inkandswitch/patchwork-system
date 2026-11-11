export interface CustomThemeDoc {
	name: string
	mode: "light" | "dark"
	variables: Record<string, string>
	customCss: string
}

export interface EditableVariable {
	key: string
	label: string
	type: "color" | "text"
	/** shown when the field is empty. blank fields are left unset, so the
	    theme.css default (or, for opt-in tokens, each tool's own value) applies. */
	placeholder?: string
}

export const EDITABLE_VARIABLES: {group: string; vars: EditableVariable[]}[] = [
	{group: "Base", vars: [
		{key: "--studio-fill", label: "Fill (background)", type: "color"},
		{key: "--studio-line", label: "Line (foreground)", type: "color"},
	]},
	{group: "Accents", vars: [
		{key: "--studio-primary", label: "Primary", type: "color"},
		{key: "--studio-secondary", label: "Secondary", type: "color"},
		{key: "--studio-danger", label: "Danger", type: "color"},
		{key: "--studio-warning", label: "Warning", type: "color"},
		{key: "--studio-success", label: "Success", type: "text", placeholder: "var(--studio-added)"},
		{key: "--studio-info", label: "Info", type: "text", placeholder: "var(--studio-secondary)"},
	]},
	{group: "Semantic", vars: [
		{key: "--studio-added", label: "Added", type: "color"},
		{key: "--studio-deleted", label: "Deleted", type: "color"},
		{key: "--studio-modified", label: "Modified", type: "color"},
		{key: "--studio-link", label: "Link", type: "color"},
	]},
	{group: "Selection", vars: [
		{key: "--studio-selection-fill", label: "Selection fill", type: "color"},
	]},
	{group: "Chrome", vars: [
		// derived by default (see theme.css); kept as text so the var() default
		// survives unless the user types a concrete value.
		{key: "--studio-chrome-fill", label: "Chrome fill", type: "text"},
		{key: "--studio-chrome-line", label: "Chrome line", type: "text"},
	]},
	{group: "Sideboard", vars: [
		{key: "--sideboard-primary", label: "Sideboard primary", type: "text"},
		{key: "--sideboard-fill", label: "Sideboard fill", type: "text"},
	]},
	{group: "Typography", vars: [
		{key: "--studio-family-sans", label: "Sans font", type: "text"},
		{key: "--studio-family-code", label: "Code font", type: "text"},
		{key: "--studio-family", label: "Default font", type: "text"},
		{key: "--studio-family-ui", label: "UI font", type: "text"},
		{key: "--studio-family-serif", label: "Serif font", type: "text", placeholder: "Iowan Old Style, Palatino, Georgia, serif"},
		{key: "--studio-font-size", label: "Font size", type: "text"},
		{key: "--studio-font-weight", label: "Font weight", type: "text", placeholder: "400"},
		{key: "--studio-line-height", label: "Line height", type: "text"},
		{key: "--studio-letter-spacing", label: "Letter spacing", type: "text", placeholder: "normal (e.g. 0.01em)"},
		{key: "--studio-chrome-letter-spacing", label: "Chrome label spacing", type: "text", placeholder: "each tool's own"},
		{key: "--studio-font-features", label: "Font features", type: "text", placeholder: "normal (e.g. \"ss01\", \"zero\")"},
		{key: "--studio-font-variation", label: "Font variation", type: "text", placeholder: "normal (e.g. \"wght\" 420)"},
		{key: "--studio-heading-family", label: "Heading font", type: "text", placeholder: "each tool's own"},
		{key: "--studio-heading-weight", label: "Heading weight", type: "text", placeholder: "each tool's own"},
		{key: "--studio-font-scale", label: "Heading scale ratio", type: "text", placeholder: "each tool's own (e.g. 1.25)"},
	]},
	{group: "Shape & density", vars: [
		{key: "--studio-density", label: "Density", type: "text", placeholder: "1 (0.75 compact, 1.25 roomy)"},
		{key: "--studio-radius-scale", label: "Corner scale", type: "text", placeholder: "1 (0 square, 1.5 soft)"},
		{key: "--studio-border-width", label: "Border width", type: "text", placeholder: "1px"},
		{key: "--studio-border-style", label: "Border style", type: "text", placeholder: "solid (dashed, dotted)"},
	]},
	{group: "Depth", vars: [
		{key: "--studio-shadow-strength", label: "Shadow strength", type: "text", placeholder: "1 (0 flat, 3 heavy)"},
		{key: "--studio-shadow-color", label: "Shadow colour", type: "text", placeholder: "the line, tinted"},
		{key: "--studio-backdrop", label: "Backdrop", type: "text", placeholder: "each tool's own"},
		{key: "--studio-backdrop-blur", label: "Backdrop blur", type: "text", placeholder: "each tool's own (e.g. blur(8px))"},
	]},
	{group: "Motion", vars: [
		{key: "--studio-motion-scale", label: "Motion scale", type: "text", placeholder: "1 (0 off, 2 slow)"},
		{key: "--studio-ease", label: "Easing", type: "text", placeholder: "ease"},
	]},
	{group: "Focus & interaction", vars: [
		{key: "--studio-focus-ring", label: "Focus ring", type: "text", placeholder: "each tool's own (e.g. 3px solid hotpink)"},
		{key: "--studio-focus-ring-offset", label: "Focus ring offset", type: "text", placeholder: "each tool's own (e.g. 2px)"},
		{key: "--studio-hover-fill", label: "Hover fill", type: "text", placeholder: "each tool's own"},
		{key: "--studio-active-fill", label: "Pressed fill", type: "text", placeholder: "each tool's own"},
		{key: "--studio-chrome-hover-fill", label: "Chrome hover fill", type: "text", placeholder: "each tool's own"},
		{key: "--studio-chrome-active-fill", label: "Chrome pressed fill", type: "text", placeholder: "each tool's own"},
		{key: "--studio-disabled-opacity", label: "Disabled opacity", type: "text", placeholder: "0.5"},
	]},
	{group: "Cursors", vars: [
		{key: "--studio-cursor-default", label: "Default", type: "text", placeholder: "default"},
		{key: "--studio-cursor-pointer", label: "Pointer", type: "text", placeholder: "pointer (e.g. url(hand.svg) 4 0, pointer)"},
		{key: "--studio-cursor-text", label: "Text", type: "text", placeholder: "text"},
		{key: "--studio-cursor-grab", label: "Grab", type: "text", placeholder: "grab"},
	]},
	{group: "Scrollbars", vars: [
		{key: "--studio-scrollbar-color", label: "Scrollbar colour", type: "text", placeholder: "browser default (thumb track)"},
		{key: "--studio-scrollbar-width", label: "Scrollbar width", type: "text", placeholder: "auto (thin, none)"},
	]},
	{group: "Swatches", vars: [
		{key: "--studio-swatch-lightness", label: "Swatch lightness", type: "text", placeholder: "0.7"},
		{key: "--studio-swatch-chroma", label: "Swatch chroma", type: "text", placeholder: "0.15"},
	]},
]

export const DEFAULT_VALUES: Record<string, string> = {
	"--studio-fill": "#ffffff",
	"--studio-line": "#000000",
	"--studio-primary": "#35f7ca",
	"--studio-secondary": "#33ccf8",
	"--studio-danger": "#ff6a90",
	"--studio-warning": "#f8c43b",
	"--studio-added": "#35f7ca",
	"--studio-deleted": "#ff6a90",
	"--studio-modified": "#f8c43b",
	"--studio-link": "#3366ee",
	"--studio-selection-fill": "#ffee8888",
	// derived defaults — mirror the var() chains in theme.css so editing the
	// source (fill/primary/sans) cascades unless overridden here.
	"--studio-chrome-fill": "var(--studio-fill-offset-10)",
	"--studio-chrome-line": "var(--studio-line)",
	"--sideboard-primary": "var(--studio-primary)",
	"--sideboard-fill": "var(--studio-chrome-fill)",
	"--studio-family-sans": '"Jost*", "Jost", system-ui, -apple-system, sans-serif',
	"--studio-family-code": '"IBM Plex Mono", ui-monospace, monospace',
	"--studio-family": "var(--studio-family-sans)",
	"--studio-family-ui": "var(--studio-family-sans)",
	"--studio-font-size": "16px",
	"--studio-line-height": "1.5",
}

export const CustomThemeDatatype = {
	init(doc: any) {
		doc.name = "Custom Theme"
		doc.mode = "light"
		doc.variables = {...DEFAULT_VALUES}
		doc.customCss = ""
	},
	getTitle(doc: any) {
		return doc.name || "Custom Theme"
	},
	setTitle(doc: any, title: string) {
		doc.name = title
	},
}
