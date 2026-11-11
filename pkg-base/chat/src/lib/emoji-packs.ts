// NOTE: import only the plain catalog here, never emoji-data.ts — this module is
// pulled into index.ts's (worker) static graph, and emoji-data.ts imports solid-js
// and fires a network fetch at load. The catalog is filled by emoji-data at runtime.
import {emojiCatalog} from "./emoji-catalog"

// Built-in `chat:emojipack` plugins — named sets of emoji for the reaction picker.
// The default "unicode" pack wraps the bundled emoji dataset (filled at runtime by
// emoji-data.ts into the plain `emojiCatalog`). A host module can register more
// packs; a tool aggregates the active ones. Custom per-user emoticons are runtime
// (chat profile), not a pack.

export interface EmojiPackPlugin {
	type: "chat:emojipack"
	id: string
	name: string
	tier: "core" | "full"
	// Deferred so we don't force the emoji dataset to load until the picker opens.
	getEmojis: () => string[]
}

export const emojiPackPlugins: EmojiPackPlugin[] = [
	{
		type: "chat:emojipack",
		id: "unicode",
		name: "Emoji",
		tier: "core",
		getEmojis: () => emojiCatalog.map((e) => e.emoji),
	},
]

// Serializable registry descriptions: metadata + an async `load()` carrying the
// `getEmojis` fn. Plugin entries are cloned worker → main with `load` excluded,
// so the function field must live behind load(). The tool reads emoji from the
// inline `emojiPackPlugins` on the main thread.
export const emojiPackDescriptions = emojiPackPlugins.map((p) => {
	const {getEmojis, ...meta} = p
	return {...meta, async load() { return {getEmojis} }}
})

/** Flatten the active packs' emoji into one de-duplicated list. */
export function collectEmojis(packs: EmojiPackPlugin[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const pack of packs) {
		let list: string[] = []
		try {
			list = pack.getEmojis() || []
		} catch {
			list = []
		}
		for (const e of list) {
			if (!seen.has(e)) {
				seen.add(e)
				out.push(e)
			}
		}
	}
	return out
}
