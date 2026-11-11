// The "@selection" feature, packaged entirely as plugins — nothing here is wired
// into the chat core. It contributes:
//
//   1. a `chat:autocomplete` provider (consumed by AutocompletePopup via the
//      generic autocomplete seam) that offers "@selection" whenever the focused
//      document has a live, non-empty text selection; and
//   2. a `chat:feature` whose `input-actions-left` slot registers a pre-send hook
//      and renders a chip. The hook resolves the "@selection" token to the live
//      selection: it stamps a cursor-anchored ref url on the outgoing message
//      (`selectionRef`) and inlines the quoted text + range so the computer sees
//      exactly which span is meant — no context-builder change required.
//
// The selection itself comes from the shared `patchwork:focus` doc, which the
// editor publishes into as a cursor-anchored ref (see codemirror-base/tool.tsx
// `onChangeSelection`); `focusSelection` resolves it back to {url, from, to, text}.
import {Show, onCleanup} from "solid-js"
import type {
	AutocompletePlugin,
	AutocompleteCtx,
	AutocompleteProvider,
} from "../lib/autocomplete-plugins"
import type {FeaturePlugin} from "../features"
import {focusSelection, selectedDocUrl} from "../lib/selected-doc"

// The token the autocomplete inserts and the pre-send hook looks for.
const TOKEN = "@selection"

function preview(text: string): string {
	const t = text.replace(/\s+/g, " ").trim()
	return t.length > 48 ? t.slice(0, 48) + "…" : t
}

// chat:autocomplete — offer "@selection" while there's a live selection.
export const selectionAutocomplete: AutocompletePlugin = {
	type: "chat:autocomplete",
	id: "selection-mention",
	tier: "core",
	create(ctx: AutocompleteCtx): AutocompleteProvider {
		// Built once, in the popup's reactive scope: a live accessor of the focused
		// doc's selection. `provide` (called per keystroke) just reads it.
		const sel = focusSelection(ctx.element, ctx.repo, selectedDocUrl(ctx.element))
		return ({trigger, query}) => {
			if (trigger !== "@") return []
			const s = sel()
			if (!s) return []
			if (!("selection".startsWith(query) || query === "")) return []
			return [
				{
					display: TOKEN,
					label: TOKEN,
					desc: s.text ? "“" + preview(s.text) + "”" : "selected text",
				},
			]
		}
	},
}

// The input-actions slot renderer: registers the pre-send hook and shows a chip.
// Authored against the explicit SlotContext (never useChat) so it stays portable
// across bundles — see context/SlotContext.tsx.
function SelectionInputAction(ctx: any, extra: any) {
	const element: HTMLElement = ctx.chat.element
	const repo = ctx.chat.repo
	const sel = focusSelection(element, repo, selectedDocUrl(element))

	// Pre-send: resolve the "@selection" token to the live selection and attach it.
	const off = extra?.registerPreSend?.((msg: any) => {
		if (!msg || typeof msg.text !== "string" || !msg.text.includes(TOKEN)) return
		const s = sel()
		if (!s) return
		// Cursor-anchored ref url — stable across edits — for provenance / future
		// precise editing, plus an inline quote so the computer has the text now.
		msg.selectionRef = s.url
		msg.text +=
			`\n[Referring to the selected text in the focused document ` +
			`(characters ${s.from}–${s.to}): «${s.text}»]`
	})
	if (off) onCleanup(off)

	return (
		<Show when={sel()}>
			{(s) => (
				<span class="chat-selection-chip" title={s().text}>
					{TOKEN}: “{preview(s().text)}”
				</span>
			)}
		</Show>
	)
}

// chat:feature — carries the slot inline (built-in features are consumed inline;
// features.ts strips the slot behind load() for host registration).
export const selectionFeature: FeaturePlugin = {
	type: "chat:feature",
	id: "selection-mention",
	name: "Selection mention",
	tier: "core",
	slots: {"input-actions-left": SelectionInputAction},
}
