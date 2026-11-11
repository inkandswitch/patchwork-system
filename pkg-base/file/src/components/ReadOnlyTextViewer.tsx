import {onCleanup} from "solid-js"
import type {DocHandle} from "@automerge/automerge-repo/slim"
import {
	EditorView,
	lineNumbers,
	highlightSpecialChars,
	highlightActiveLineGutter,
	highlightActiveLine,
	keymap,
	scrollPastEnd,
} from "@codemirror/view"
import {EditorState} from "@codemirror/state"
import {bracketMatching, foldGutter, foldKeymap} from "@codemirror/language"
import {highlightSelectionMatches, searchKeymap} from "@codemirror/search"
import {defaultKeymap} from "@codemirror/commands"
import codemirrorTheme from "../codemirror-theme"
import {getLanguageExtension} from "../languages"
import type {FileDoc} from "../types"
import {fileText} from "../datatype"
import {collectExtensions} from "./codemirror-extensions"
import {createFileComments} from "./comments"

// Read-only text: ImmutableString files, and any text file opened through a
// read-only handle. It follows the file as it changes (an ImmutableString is
// replaced whole, so the view is too).
export function ReadOnlyTextViewer(props: {
	doc: FileDoc
	handle?: DocHandle<FileDoc>
	element?: HTMLElement
}) {
	const languageExtension = getLanguageExtension(
		props.doc.extension,
		props.doc.mimeType,
	)

	// Read-only to the editor, but the file can still take comments (unless
	// it's an ImmutableString — see createFileComments).
	const comments =
		props.handle && props.element
			? createFileComments({handle: props.handle, element: props.element})
			: undefined

	const view = new EditorView({
		doc: fileText(props.handle?.doc() ?? props.doc),
		extensions: [
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			lineNumbers(),
			highlightSpecialChars(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			foldGutter(),
			bracketMatching(),
			EditorState.tabSize.of(2),
			EditorView.lineWrapping,
			scrollPastEnd(),
			keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
			languageExtension,
			...codemirrorTheme,
			comments?.extension ?? [],
			// last, so they can override anything above
			collectExtensions(props.element, props.handle, props.doc, true),
		],
	})

	const follow = () => {
		const text = fileText(props.handle?.doc())
		if (text === view.state.doc.toString()) return
		view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}})
	}
	props.handle?.on("change", follow)
	comments?.attach(view)

	onCleanup(() => {
		props.handle?.off("change", follow)
		view.destroy()
	})

	return (
		<div
			ref={(el) => {
				el.appendChild(view.dom)
			}}
			style={{
				width: "100%",
				height: "100%",
			}}
		/>
	)
}
