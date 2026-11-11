// Built-in `chat:syntax` plugins — inline/block formatting, as cute.txt-shaped
// specs behind `async load()`. This is the author-facing contract: a plugin
// declares a `kind` ("mark" | "block" | "replace") and `load()`s the actual spec
// (pattern + toDOM etc). chat adapts these onto its rich-text engine internally
// (see lib/syntax-schema.ts) — authors never see the engine.
//
// A spec is matched against the RAW message string (which contains its own
// delimiters, e.g. `*bold*`); formatting is applied at render time.
//
// The base owns only the core bold/italic/code/link; the rest (underline, spoiler,
// strike, …) come from the chitter bundle. Descriptions carry only `load()` as a
// function, so they clone cleanly worker→main (like slashPluginDescriptions).

// A cute.txt mark/block/replace spec. Kept structural (the engine consumes it).
export interface SyntaxSpec {
	pattern: RegExp
	// mark: () => [tagName] | [tagName, attrs]. block/replace: (attrs) => Node.
	toDOM: (attrs?: any) => any
	parse?: (match: string) => any
	token?: (attrs: any) => string
	key?: string
	wrap?: string
	raw?: boolean
}

export interface SyntaxPlugin {
	type: "chat:syntax"
	id: string
	name: string
	tier: "core" | "full"
	kind: "mark" | "block" | "replace"
	icon?: string
	load: () => Promise<SyntaxSpec>
}

// The base's core formatting. `code` and `link` are core (always on).
export const syntaxPlugins: SyntaxPlugin[] = [
	{
		type: "chat:syntax", id: "italic", name: "Italic", tier: "core", kind: "mark",
		async load() {
			return {pattern: /(?<![_\w])_([^_\n]+?)_(?![_.\w])/, toDOM: () => ["em"], key: "Mod-i", wrap: "_"}
		},
	},
	{
		type: "chat:syntax", id: "bold", name: "Bold", tier: "core", kind: "mark",
		async load() {
			return {pattern: /\*([^*\n]+?)\*/, toDOM: () => ["strong"], key: "Mod-b", wrap: "*"}
		},
	},
	{
		type: "chat:syntax", id: "code", name: "Code", tier: "core", kind: "mark",
		async load() {
			// raw: don't format inner content (backtick text stays literal).
			return {pattern: /`([^`\n]+?)`/, toDOM: () => ["code"], raw: true, wrap: "`"}
		},
	},
	{
		type: "chat:syntax", id: "link", name: "Link", tier: "core", kind: "mark",
		async load() {
			return {
				pattern: /(https?:\/\/[^\s<]+)/,
				parse: (s: string) => ({href: s}),
				toDOM: ({href}: {href: string}) => ["a", {href, target: "_blank", rel: "noopener"}],
			}
		},
	},
]

// Registration descriptions (already description-shaped — only `load()` carries a
// function, so they clone worker→main safely). Kept as a distinct export to mirror
// slashPluginDescriptions/etc. in index.ts.
export const syntaxPluginDescriptions = syntaxPlugins
