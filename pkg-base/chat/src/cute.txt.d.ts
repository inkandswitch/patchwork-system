// Type declarations for the cute.txt subpath entrypoints chat imports. The package
// ships plain .js without .d.ts, so declare the surface we use here.

declare module "cute.txt/markup" {
	// A parsed node: {text} | {mark, attrs, children} | {atom, attrs, block}.
	export function parseMarkup(text: string, schema: any): any[]
	export function findMarkupRanges(text: string, schema: any): any[]
	export function toPlainText(text: string, schema: any): string
}

declare module "cute.txt/preview" {
	// Live-preview extension (decorations + Mod-B/I/U + optional paste/drop).
	// getSchema returns the cute.txt schema ({marks, blocks, replaces}).
	export function cutePreview(
		getSchema: () => any,
		opts?: {repo?: any; getToolsForDoc?: (url: string) => Promise<any[]>}
	): any[]
}

declare module "cute.txt/autocomplete" {
	// A completion spec: {trigger: RegExp, options(query, ctx) -> option[]}.
	// Returns CodeMirror Extension[] usable on any EditorView.
	export function cuteAutocomplete(
		getSpecs: () => any[],
		opts?: {
			className?: string
			itemClass?: string
			max?: number
			renderRow?: (opt: any, ctx: {index: number; active: boolean}) => HTMLElement
		}
	): any[]
}
