// Plain, side-effect-free snapshot of the loaded unicode emoji list.
//
// This exists so index.ts (the plugin entrypoint, which runs in a WORKER) can
// register the built-in `unicode` chat:emojipack WITHOUT statically importing
// anything browsery. emoji-data.ts imports solid-js and fires an esm.sh network
// fetch at module load — that must never end up in the worker's static graph.
// The `unicode` pack reads from this plain array instead; emoji-data.ts (browser
// only) fills it in once its async dataset resolves.

export interface EmojiEntry {
	emoji: string
	name: string
	group: string
}

export const emojiCatalog: EmojiEntry[] = []

export function setEmojiCatalog(list: EmojiEntry[]) {
	emojiCatalog.length = 0
	emojiCatalog.push(...list)
}
