// The `chat:autocomplete` extension seam. The built-in triggers (slash `/`, emoji
// `:`, mention `@`) live in lib/completion.ts; this lets a plugin contribute extra
// items for the `@` trigger without touching the input wiring. Resolved like the
// other function-valued plugin types (chat:slash etc.) through `createLoadedPlugins`,
// so a cross-bundle contribution rides behind `async load()` while built-ins are
// used inline.
//
// A provider is built once via `create(ctx)` — where it may set up reactive state
// (a live selection accessor, the presence roster) — and the returned function is
// called on each keystroke with the active trigger and query.
import type {Accessor} from "solid-js"
import type {Repo} from "@automerge/automerge-repo/slim"
import type {PluginSelector} from "./registry"
import type {AutocompleteItem} from "./completion"
import {fuzzyMatch, fuzzyScore} from "./completion"
import {selectionAutocomplete} from "../features/selection-mention"

export interface AutocompleteCtx {
	element: HTMLElement
	repo: Repo
	selector: Accessor<PluginSelector>
	// Live chat participant names (presence roster). Supplied by InputArea, which
	// has usePresence(); lets a provider offer people without importing the context.
	presence: Accessor<string[]>
}

export type AutocompleteProvider = (input: {
	trigger: "@" | "/" | ":"
	query: string
}) => AutocompleteItem[]

export interface AutocompletePlugin {
	type: "chat:autocomplete"
	id: string
	tier: "core" | "full"
	create: (ctx: AutocompleteCtx) => AutocompleteProvider
}

// @-mention people: names from the live presence roster + the AI ("computer").
const peopleAutocomplete: AutocompletePlugin = {
	type: "chat:autocomplete",
	id: "people-mention",
	tier: "core",
	create(ctx) {
		return ({trigger, query}) => {
			if (trigger !== "@") return []
			const q = query.toLowerCase()
			const names = new Set<string>(ctx.presence())
			names.add("computer")
			const items: AutocompleteItem[] = []
			for (const name of names) {
				if (name.toLowerCase().startsWith(q) || fuzzyMatch(q, name)) {
					items.push({
						display: "@" + name,
						label: "@" + name,
						desc: name === "computer" ? "AI assistant" : "user",
					})
				}
			}
			items.sort((a, b) => fuzzyScore(q, a.label.slice(1)) - fuzzyScore(q, b.label.slice(1)))
			return items
		}
	},
}

// Built-in providers (merged with host-registered ones by createLoadedPlugins).
export const autocompletePlugins: AutocompletePlugin[] = [peopleAutocomplete, selectionAutocomplete]
