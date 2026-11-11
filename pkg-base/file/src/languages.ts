import type {Extension} from "@codemirror/state"
import {javascript} from "@codemirror/lang-javascript"
import {css} from "@codemirror/lang-css"
import {html} from "@codemirror/lang-html"
import {json} from "@codemirror/lang-json"
import {markdown} from "@codemirror/lang-markdown"
import {python} from "@codemirror/lang-python"
import {xml} from "@codemirror/lang-xml"
import {yaml} from "@codemirror/lang-yaml"
import {rust} from "@codemirror/lang-rust"
import {cpp} from "@codemirror/lang-cpp"
import {java} from "@codemirror/lang-java"
import {php} from "@codemirror/lang-php"
import {sql} from "@codemirror/lang-sql"
import {wast} from "@codemirror/lang-wast"

const extensionMap: Record<string, () => Extension> = {
	".js": () => javascript(),
	".mjs": () => javascript(),
	".cjs": () => javascript(),
	".jsx": () => javascript({jsx: true}),
	".ts": () => javascript({typescript: true}),
	".mts": () => javascript({typescript: true}),
	".cts": () => javascript({typescript: true}),
	".tsx": () => javascript({jsx: true, typescript: true}),
	".css": () => css(),
	".html": () => html(),
	".htm": () => html(),
	".svelte": () => html(),
	".vue": () => html(),
	".json": () => json(),
	".jsonc": () => json(),
	".md": () => markdown(),
	".markdown": () => markdown(),
	".mdx": () => markdown(),
	".py": () => python(),
	".xml": () => xml(),
	".svg": () => xml(),
	".yaml": () => yaml(),
	".yml": () => yaml(),
	".rs": () => rust(),
	".c": () => cpp(),
	".h": () => cpp(),
	".cpp": () => cpp(),
	".hpp": () => cpp(),
	".cc": () => cpp(),
	".cxx": () => cpp(),
	".java": () => java(),
	".php": () => php(),
	".sql": () => sql(),
	".wat": () => wast(),
	".wast": () => wast(),
}

const mimeMap: Record<string, () => Extension> = {
	"text/javascript": () => javascript(),
	"application/javascript": () => javascript(),
	"text/typescript": () => javascript({typescript: true}),
	"text/css": () => css(),
	"text/html": () => html(),
	"application/json": () => json(),
	"text/markdown": () => markdown(),
	"text/x-python": () => python(),
	"text/xml": () => xml(),
	"application/xml": () => xml(),
	"image/svg+xml": () => xml(),
	"text/yaml": () => yaml(),
	"text/x-yaml": () => yaml(),
	"text/x-rustsrc": () => rust(),
	"text/x-csrc": () => cpp(),
	"text/x-c++src": () => cpp(),
	"text/x-java": () => java(),
	"text/x-sql": () => sql(),
}

export function getLanguageExtension(
	extension?: string,
	mimeType?: string,
): Extension {
	if (extension) {
		const ext = extension.startsWith(".") ? extension : `.${extension}`
		const factory = extensionMap[ext]
		if (factory) return factory()
	}
	if (mimeType) {
		const factory = mimeMap[mimeType]
		if (factory) return factory()
	}
	return []
}
