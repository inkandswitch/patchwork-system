// Copied from codemirror-base's lib/extensions/commentUI.ts (tools don't share
// code at build time). The one change: whether comments can be made is asked
// of the host (`canComment`) instead of read off the editor's readOnly, since
// a file the editor won't let you edit can still take comments.

import {
	Extension,
	StateEffect,
	StateField,
	type EditorState,
} from "@codemirror/state"
import {
	EditorView,
	showTooltip,
	type Tooltip,
	type TooltipView,
} from "@codemirror/view"
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {COMMENT_THREAD_TYPE} from "./threads"

// The data hooks the editor UI needs from its host (the CodeMirror tool). The
// extension owns all the DOM/positioning/lifecycle; the host owns everything
// that needs the repo, the current contact, or the comment index.
export type CommentUIOptions = {
	// Create a thread targeting [from, to] and return its url, or null if it
	// couldn't be created (e.g. no current contact). Called when the floating
	// "Comment" button is clicked.
	createThreadForRange: (from: number, to: number) => AutomergeUrl | null
	// Map a document position to the thread whose commented range covers it (and
	// that range's start), or null. Called when the user clicks commented text so
	// we can pop that thread open under the range's start.
	threadAtPos: (
		pos: number
	) => {threadUrl: AutomergeUrl; from: number} | null
	// Watch a thread and invoke `close` once its pending draft is submitted (or
	// cancelled, or the thread is removed). Returns an unsubscribe. Lets the
	// popover dismiss itself the moment the comment is saved.
	watchThreadForClose: (threadUrl: AutomergeUrl, close: () => void) => () => void
	// Called whenever a popover closes, for any reason. Lets the host discard an
	// abandoned, never-filled-in draft so dismissing the popover doesn't litter
	// the document with empty comments.
	onClose: (threadUrl: AutomergeUrl) => void
	// Whether the doc will take a comment right now. When it won't, there's no
	// "Comment" button and clicking commented text doesn't open the thread (its
	// reply box would write into a doc that rejects writes).
	canComment: () => boolean
}

// Which thread the popover is showing, and the document position it hangs off.
type PopoverState = {threadUrl: AutomergeUrl; anchor: number}

const openPopover = StateEffect.define<PopoverState>()
const closePopover = StateEffect.define<null>()
// Hide the floating "Comment" button until the next selection change (Escape).
const dismissButton = StateEffect.define<null>()

// Mutable UI state shared across the extension's pieces (not editor state
// because it isn't versioned/undoable): the thread we most recently dismissed,
// so a click that stays inside it doesn't immediately pop it back open.
type CommentUIState = {suppressed: AutomergeUrl | null}

const POPOVER_CLASS = "cm-comment-popover"

// A speech-bubble icon + "Comment" label, shown floating above the selection.
const buildCommentButton = (
	from: number,
	to: number,
	head: number,
	view: EditorView,
	options: CommentUIOptions
): HTMLElement => {
	const button = document.createElement("button")
	button.className = "cm-comment-button"
	button.setAttribute("aria-label", "Comment")

	button.innerHTML = `
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
				xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
						fill="currentColor" stroke="none"/>
		</svg>
		<span>Comment</span>
	`

	// Without this, the browser focuses the button on mousedown, the editor
	// blurs, the selection collapses, our tooltip source returns null, and
	// CodeMirror tears down the button before `click` fires — so the first
	// press silently does nothing and the user has to click twice. Swallowing
	// mousedown keeps the editor focused and the selection (and button) alive
	// long enough for the click to land.
	button.addEventListener("mousedown", (e) => {
		e.preventDefault()
		e.stopPropagation()
	})

	button.addEventListener("click", (e) => {
		e.preventDefault()
		e.stopPropagation()
		const threadUrl = options.createThreadForRange(from, to)
		if (!threadUrl) return
		// Open the popover right where the button was (the selection head).
		view.dispatch({effects: openPopover.of({threadUrl, anchor: head})})
	})

	return button
}

// The popover body: the shared comment-thread tool, rendered inline via the
// `patchwork-view` custom element. It's mounted inside `view.dom`, so the
// element's provider events (repo, contact, …) still bubble up to the host.
const buildThreadPopover = (
	view: EditorView,
	state: PopoverState,
	options: CommentUIOptions,
	ui: CommentUIState
): TooltipView => {
	const dom = document.createElement("div")
	dom.className = POPOVER_CLASS

	const threadView = document.createElement("patchwork-view")
	threadView.setAttribute("doc-url", state.threadUrl)
	threadView.setAttribute("tool-id", COMMENT_THREAD_TYPE)
	dom.append(threadView)

	const close = () => view.dispatch({effects: closePopover.of(null)})

	// Dismiss on a click anywhere outside the popover, or on Escape. Both are
	// armed on a deferred tick so the very interaction that opened the popover
	// (the button click / the click on commented text) doesn't also close it.
	const onOutsideMouseDown = (event: MouseEvent) => {
		if (!dom.contains(event.target as Node)) close()
	}
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") close()
	}
	const doc = view.dom.ownerDocument
	const win = doc.defaultView ?? window
	const armTimer = win.setTimeout(() => {
		doc.addEventListener("mousedown", onOutsideMouseDown, true)
		doc.addEventListener("keydown", onKeyDown, true)
	}, 0)

	// Close as soon as the draft is submitted (or the thread goes away).
	const stopWatch = options.watchThreadForClose(state.threadUrl, close)

	return {
		dom,
		destroy() {
			win.clearTimeout(armTimer)
			doc.removeEventListener("mousedown", onOutsideMouseDown, true)
			doc.removeEventListener("keydown", onKeyDown, true)
			stopWatch()
			// Remember this thread as dismissed so clicking within its range again
			// doesn't immediately reopen it (cleared once a click lands elsewhere).
			ui.suppressed = state.threadUrl
			options.onClose(state.threadUrl)
		},
	}
}

const buttonTooltip = (
	state: EditorState,
	options: CommentUIOptions
): Tooltip | null => {
	const sel = state.selection.main
	if (sel.empty || !options.canComment()) return null

	// Anchor the button at the drag tail (the selection head) rather than the
	// start, so dragging left-to-right lands it on the right and right-to-left
	// on the left.
	return {
		pos: sel.head,
		above: true,
		strictSide: false,
		arrow: false,
		create: (view) => ({
			dom: buildCommentButton(sel.from, sel.to, sel.head, view, options),
		}),
	}
}

const popoverTooltip = (
	state: PopoverState,
	options: CommentUIOptions,
	ui: CommentUIState
): Tooltip => ({
	pos: state.anchor,
	above: false, // comes out underneath the anchor
	strictSide: false,
	arrow: false,
	create: (view) => buildThreadPopover(view, state, options, ui),
})

type FieldValue = {
	popover: PopoverState | null
	// The floating button is hidden while this is true — after Escape, or after a
	// comment is added — until a fresh selection re-arms it.
	buttonDismissed: boolean
	tooltip: Tooltip | null
}

// A single field driving the one tooltip slot: the thread popover when one is
// open, otherwise the selection's "Comment" button.
const commentUIField = (options: CommentUIOptions, ui: CommentUIState) =>
	StateField.define<FieldValue>({
		create: (state) => ({
			popover: null,
			buttonDismissed: false,
			tooltip: buttonTooltip(state, options),
		}),
		update(value, tr) {
			let popover = value.popover
			let buttonDismissed = value.buttonDismissed
			let popoverChanged = false

			// Keep the popover pinned to its text as the document shifts under it.
			if (popover && tr.docChanged) {
				popover = {...popover, anchor: tr.changes.mapPos(popover.anchor)}
				popoverChanged = true
			}
			for (const effect of tr.effects) {
				if (effect.is(openPopover)) {
					popover = effect.value
					popoverChanged = true
				} else if (effect.is(closePopover)) {
					popover = null
					popoverChanged = true
					// A comment was just added (or dismissed): don't flash the button
					// back up over the still-selected text.
					buttonDismissed = true
				} else if (effect.is(dismissButton)) {
					buttonDismissed = true
				}
			}
			// Any fresh selection re-arms the button.
			if (tr.selection) buttonDismissed = false

			if (popover) {
				// Reuse the exact same tooltip object unless the popover state itself
				// changed. Otherwise an unrelated transaction (a stray selection
				// change, an extension reconfigure, …) would hand CodeMirror a fresh
				// Tooltip and it would tear down and remount the thread view mid-edit.
				if (!popoverChanged) {
					return buttonDismissed === value.buttonDismissed
						? value
						: {...value, buttonDismissed}
				}
				return {
					popover,
					buttonDismissed,
					tooltip: popoverTooltip(popover, options, ui),
				}
			}

			// No popover: show the selection button, unless it's been dismissed.
			// Recompute only when something relevant changed.
			if (
				!popoverChanged &&
				!tr.docChanged &&
				!tr.selection &&
				buttonDismissed === value.buttonDismissed
			) {
				return value
			}
			return {
				popover: null,
				buttonDismissed,
				tooltip: buttonDismissed ? null : buttonTooltip(tr.state, options),
			}
		},
		provide: (field) => showTooltip.from(field, (value) => value.tooltip),
	})

// Editor-level interactions: click commented text to (re)open its thread, and
// Escape to dismiss the floating button.
const commentInteractions = (
	options: CommentUIOptions,
	ui: CommentUIState,
	field: StateField<FieldValue>
): Extension =>
	EditorView.domEventHandlers({
		mousedown(event, view) {
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey
			) {
				return false
			}
			// Clicks inside an open popover are the thread tool's own business.
			if ((event.target as HTMLElement | null)?.closest("." + POPOVER_CLASS)) {
				return false
			}
			if (!options.canComment()) return false
			const pos = view.posAtCoords({x: event.clientX, y: event.clientY})
			if (pos == null) return false
			const hit = options.threadAtPos(pos)
			if (!hit) {
				ui.suppressed = null // clicked away from any comment; re-arm reopening
				return false
			}
			// Don't reopen the thread we just dismissed while the click stays inside
			// it — the user has to click elsewhere (or another comment) first.
			if (hit.threadUrl === ui.suppressed) return false
			ui.suppressed = null
			view.dispatch({
				effects: openPopover.of({threadUrl: hit.threadUrl, anchor: hit.from}),
			})
			return false; // let the click also move the cursor as usual
		},
		keydown(event, view) {
			if (event.key !== "Escape") return false
			const state = view.state.field(field, false)
			// While a popover is open its own Escape handler wins (it also works when
			// the popover's textarea holds focus); here we only hide the button.
			if (!state || state.popover || !state.tooltip) return false
			view.dispatch({effects: dismissButton.of(null)})
			return true
		},
	})

// Global colours are lifted into local --cm-comment-* tokens in a
// :root/:host/[theme] block so they re-evaluate when the theme swaps. This
// derivation can't live in the baseTheme below — CodeMirror prefixes every
// non-"&" selector with the editor's scope class, so a `:root` key would
// become `.cm... :root` and never match. It's injected as a plain stylesheet
// instead, and the button reads only the derived tokens. The button is editor
// UI, so it derives from --editor-* (not --studio-*, which is studio chrome).
const COMMENT_BUTTON_VARS_ID = "cm-comment-button-vars"
const ensureCommentButtonVars = (): void => {
	if (
		typeof document === "undefined" ||
		document.getElementById(COMMENT_BUTTON_VARS_ID)
	) {
		return
	}
	const style = document.createElement("style")
	style.id = COMMENT_BUTTON_VARS_ID
	style.textContent = `
		:root, :host, [theme] {
			/* the button sits on the editor surface: bg is the plain editor fill,
				text is the editor ink, and hover lifts a gentle one step up the fill
				ramp. see --text-editor-* in the theme. */
			--cm-comment-button-fg: var(--text-editor-line, #0a2b23);
			--cm-comment-button-bg: var(--text-editor-fill, #35f7ca);
			--cm-comment-button-bg-hover: var(--text-editor-fill-offset-10, #2ce0b6);
		}
	`
	document.head.append(style)
}

const commentUITheme = EditorView.baseTheme({
	".cm-tooltip:has(.cm-comment-button)": {
		border: "none",
		background: "transparent",
		boxShadow: "none",
	},
	".cm-comment-button": {
		display: "inline-flex",
		alignItems: "center",
		gap: "5px",
		padding: "4px 9px",
		font: "inherit",
		fontSize: "12px",
		fontWeight: "500",
		lineHeight: "1",
		color: "var(--cm-comment-button-fg)",
		background: "var(--cm-comment-button-bg)",
		border: "none",
		borderRadius: "6px",
		boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
		cursor: "var(--studio-cursor-pointer, pointer)",
		userSelect: "none",
		whiteSpace: "nowrap",
		transition: "background-color max(1ms, calc(0.15s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)))",
	},
	".cm-comment-button:hover": {
		background: "var(--cm-comment-button-bg-hover)",
	},
	".cm-comment-button svg": {
		display: "block",
	},
	// The thread tool carries its own card (background, border, padding), so the
	// tooltip wrapper is just a transparent, softly-lifted host for it.
	".cm-tooltip:has(.cm-comment-popover)": {
		border: "none",
		background: "transparent",
		boxShadow: "none",
	},
	".cm-comment-popover": {
		width: "min(360px, 92vw)",
		marginTop: "6px",
		fontFamily: "var(--editor-family)",
		filter: "drop-shadow(0 4px 14px rgba(0, 0, 0, 0.25))",
	},
	// The popover supplies its own frame (the tooltip wrapper's shadow), so the
	// thread card inside drops its own border and shadow to avoid doubling up.
	".cm-comment-popover .comments-thread-card": {
		border: "0",
		boxShadow: "none",
	},
	// The draft textarea is width:100% with its own padding + border; without
	// border-box it spills out of the card's right edge (the card's own reset is
	// scoped to the sidebar panel, which the popover isn't inside).
	".cm-comment-popover .comment-draft-editor": {
		boxSizing: "border-box",
		maxWidth: "100%",
		minWidth: "0",
		width: "100%",
	},
	".cm-comment-popover .comment-draft-editor .cm-content": {
		minHeight: "0",
		minWidth: "0",
		margin: "0",
		padding: "8px",
	},
	".cm-comment-popover .comment-draft-editor .cm-line": {
		margin: "0",
		padding: "0",
	},
	".cm-comment-popover .comment-draft-editor .cm-scroller": {
		minWidth: "0",
	},
})

// The comment UI: the floating "Comment" button on a selection, and the thread
// popover it (and clicking commented text) opens.
export const commentUI = (options: CommentUIOptions): Extension => {
	ensureCommentButtonVars()
	const ui: CommentUIState = {suppressed: null}
	const field = commentUIField(options, ui)
	return [field, commentInteractions(options, ui, field), commentUITheme]
}
