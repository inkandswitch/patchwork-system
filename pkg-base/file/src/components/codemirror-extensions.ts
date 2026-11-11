import type {Extension} from "@codemirror/state"
import type {FileDoc} from "../types"

// The event a tool embedding this one (in a <patchwork-view tool-id="file">)
// listens for to add its own CodeMirror extensions. Both the editor and the
// read-only viewer dispatch it once, just before they create their view, and
// it bubbles out of the patchwork-view; a listener pushes onto
// `detail.extensions`. Extensions have to come from the shared @codemirror/*
// modules in the import map, like these editors'. `readOnly` says which one
// asked.
export const CODEMIRROR_EXTENSIONS_EVENT = "file:codemirror-extensions"

export type CodemirrorExtensionsDetail = {
	handle: any
	doc: FileDoc
	readOnly: boolean
	extensions: Extension[]
}

export function collectExtensions(
	element: HTMLElement | undefined,
	handle: any,
	doc: FileDoc,
	readOnly: boolean,
): Extension[] {
	if (!element) return []
	const detail: CodemirrorExtensionsDetail = {
		handle,
		doc,
		readOnly,
		extensions: [],
	}
	element.dispatchEvent(
		new CustomEvent(CODEMIRROR_EXTENSIONS_EVENT, {
			detail,
			bubbles: true,
			composed: true,
		}),
	)
	return detail.extensions
}
