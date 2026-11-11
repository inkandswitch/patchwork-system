// Input autocomplete, expressed as cute.txt autocomplete specs. The cute.txt engine
// (cuteAutocomplete, added to InputArea's editor) drives the popup + keyboard; this
// module supplies the three built-in triggers (slash / emoji-emoticon / @mention),
// the adapter from chat's rich AutocompleteItem to a cute.txt option, and the row
// renderer that emits chat's own markup. The `chat:autocomplete` extension seam
// (autocomplete-plugins.ts) feeds extra items into the @mention trigger.

import type {Accessor} from "solid-js"
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {EMOJI_ALIASES, EMOJI_DATA, EMOJI_LOADED} from "./emoji-data"
import {resolvePlugins, type PluginSelector} from "./registry"
import {slashPlugins} from "./slash-plugins"
import type {AutocompleteProvider} from "./autocomplete-plugins"

// The rich item shape chat providers return.
export interface AutocompleteItem {
	display: string // text inserted (":catjam:" | emoji char | "@name" | "/cmd ")
	label: string
	desc: string
	emoji?: string
	url?: AutomergeUrl
	isCommand?: boolean
	cmd?: string
}

// A cute.txt autocomplete option.
export interface CuteOption {
	label: string
	insert: string
	detail?: string
	icon?: {kind: "emoji"; char: string} | {kind: "image"; src: string} | {kind: "person"}
	replace?: "match" | "all" | "line"
}

export const emoticonImgSrc = (url: AutomergeUrl | string) => "/" + encodeURIComponent(url) + "/"

export function fuzzyMatch(query: string, target: string): boolean {
	const q = query.replace(/[-_]/g, "").toLowerCase()
	const t = target.replace(/[-_]/g, "").toLowerCase()
	let qi = 0
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) qi++
	}
	return qi === q.length
}

export function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase()
	const t = target.replace(/[-_]/g, " ").toLowerCase()
	if (t.startsWith(q)) return 0
	if (t.includes(q)) return 1
	return 2
}

function getAllEmoticons(
	myEmoticons: Record<string, AutomergeUrl>,
	peerEmoticons: Record<string, Record<string, AutomergeUrl>>
): {name: string; url: AutomergeUrl}[] {
	const seen = new Set<string>()
	const result: {name: string; url: AutomergeUrl}[] = []
	for (const [name, url] of Object.entries(myEmoticons)) {
		if (!seen.has(name)) {
			seen.add(name)
			result.push({name, url})
		}
	}
	for (const peerMap of Object.values(peerEmoticons)) {
		for (const [name, url] of Object.entries(peerMap)) {
			if (!seen.has(name)) {
				seen.add(name)
				result.push({name, url})
			}
		}
	}
	return result
}

// Emoji/emoticon search (custom emoticons → emoji aliases → full unicode catalog).
export function searchEmoji(
	query: string,
	myEmoticons: Record<string, AutomergeUrl>,
	peerEmoticons: Record<string, Record<string, AutomergeUrl>>
): AutocompleteItem[] {
	const results: AutocompleteItem[] = []
	const seenEmoji = new Set<string>()

	for (const {name, url} of getAllEmoticons(myEmoticons, peerEmoticons)) {
		if (fuzzyMatch(query, name)) results.push({display: `:${name}:`, label: `:${name}:`, desc: "custom", url})
	}
	for (const [alias, emoji] of Object.entries(EMOJI_ALIASES)) {
		if (seenEmoji.has(emoji)) continue
		if (fuzzyMatch(query, alias)) {
			seenEmoji.add(emoji)
			results.push({display: emoji, label: `:${alias}:`, desc: "", emoji})
		}
	}
	if (EMOJI_LOADED()) {
		for (const entry of EMOJI_DATA()) {
			if (seenEmoji.has(entry.emoji)) continue
			if (fuzzyMatch(query, entry.name)) {
				seenEmoji.add(entry.emoji)
				results.push({display: entry.emoji, label: entry.name, desc: entry.group, emoji: entry.emoji})
			}
			if (results.length >= 12) break
		}
	}
	results.sort((a, b) => fuzzyScore(query, a.label) - fuzzyScore(query, b.label))
	return results.slice(0, 12)
}

// chat's rich item -> a cute.txt option. Commands replace the whole doc; token
// completions replace the trigger span and add a trailing space (as before).
export function acItemToOption(item: AutocompleteItem): CuteOption {
	if (item.isCommand) {
		return {label: item.label, detail: item.desc, insert: item.display, replace: "all"}
	}
	return {
		label: item.label,
		detail: item.desc,
		insert: item.display + " ",
		icon: item.url
			? {kind: "image", src: emoticonImgSrc(item.url)}
			: item.emoji
				? {kind: "emoji", char: item.emoji}
				: {kind: "person"},
	}
}

// Person glyph for @mention rows (static markup, no user content — safe innerHTML).
const PERSON_SVG =
	'<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>'

// Row builder emitting chat's markup so chat.css styles the popup.
export function chatRenderRow(opt: CuteOption, ctx: {active: boolean}): HTMLElement {
	const row = document.createElement("div")
	row.className = "chat-autocomplete-item" + (ctx.active ? " active" : "")
	const isCommand = opt.replace === "all"
	if (!isCommand) {
		const cell = document.createElement("span")
		cell.className = "chat-autocomplete-item-emoji"
		if (opt.icon?.kind === "image") {
			const img = document.createElement("img")
			img.src = opt.icon.src
			cell.append(img)
		} else if (opt.icon?.kind === "emoji") {
			cell.textContent = opt.icon.char
		} else {
			cell.innerHTML = PERSON_SVG
		}
		row.append(cell)
	}
	const name = document.createElement("span")
	name.className = isCommand ? "chat-autocomplete-item-cmd" : "chat-autocomplete-item-name"
	name.textContent = opt.label
	row.append(name)
	if (opt.detail) {
		const desc = document.createElement("span")
		desc.className = "chat-autocomplete-item-desc"
		desc.textContent = opt.detail
		row.append(desc)
	}
	return row
}

// The three built-in completion triggers, as cute.txt specs. Triggers use
// lookbehind so `from = caret - match[0].length` lands on the token start.
export function createCompletionSpecs(deps: {
	selector: Accessor<PluginSelector>
	myEmoticons: Accessor<Record<string, AutomergeUrl>>
	peerEmoticons: Accessor<Record<string, Record<string, AutomergeUrl>>>
	mentionProviders: Accessor<AutocompleteProvider[]>
}) {
	return [
		{
			// slash command — whole input is `/cmd` (no space yet). Replaces the doc.
			trigger: /^\/([\w-]*)$/,
			options(q: string): CuteOption[] {
				const query = q.toLowerCase()
				const active = resolvePlugins("chat:slash", slashPlugins, deps.selector())
				return active
					.filter((cmd: any) => {
						const name = cmd.cmd.slice(1)
						return name.startsWith(query) || (cmd.aliases || []).some((a: string) => a.slice(1).startsWith(query))
					})
					.map((cmd: any) =>
						acItemToOption({display: cmd.cmd + " ", label: cmd.usage, desc: cmd.desc, isCommand: true, cmd: cmd.cmd})
					)
			},
		},
		{
			// :emoji: / :emoticon:
			trigger: /(?<=^|[\s{[(]):([\w+-]+)$/,
			options(q: string): CuteOption[] {
				return searchEmoji(q, deps.myEmoticons(), deps.peerEmoticons()).map(acItemToOption)
			},
		},
		{
			// @mention — items come entirely from chat:autocomplete providers (people
			// + @selection etc.), so third-party mention sources plug in here.
			trigger: /(?<=^|\s)@([\w-]*)$/,
			options(q: string): CuteOption[] {
				const items: AutocompleteItem[] = []
				for (const provide of deps.mentionProviders()) {
					try {
						const extra = provide({trigger: "@", query: q})
						if (extra && extra.length) items.push(...extra)
					} catch {}
				}
				return items.slice(0, 8).map(acItemToOption)
			},
		},
	]
}
