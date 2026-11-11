// Adapter: build a cute.txt schema from the active `chat:syntax` plugins plus a few
// chat-INTERNAL specs (emoticons, shiki code fences, <think>) that aren't part of
// the author-facing contract. This is the only place chat couples to the cute.txt
// engine shape; authors only ever see `chat:syntax`.
//
// `chat:syntax` plugins are resolved via createLoadedPlugins, which flattens each
// plugin's loaded spec (pattern/toDOM/…) onto the plugin object, so a resolved
// plugin IS a usable cute.txt spec (with extra id/kind/tier fields the engine
// ignores). We bucket by `kind` and merge the internal specs on top.
//
// The code-fence and <think> specs carry a private `_chatKind` marker so
// MessageBody can render them with its stable Solid components (CodeBlock/ThinkBlock)
// instead of the spec's fallback toDOM — preserving shiki's streaming behaviour.

import {createMemo, type Accessor} from "solid-js"
import {createLoadedPlugins} from "./slots"
import type {PluginSelector} from "./registry"
import {syntaxPlugins} from "./syntax"
import {EMOJI_ALIASES, EMOJI_DATA} from "./emoji-data"

export interface CuteSchema {
	marks: Record<string, any>
	blocks: Record<string, any>
	replaces: Record<string, any>
}

// Tolerant of an unclosed trailing fence/think while streaming.
const CODE_FENCE = /```([\w.-]*)\n([\s\S]*?)(?:```|$)/
const THINK = /<think>([\s\S]*?)(?:<\/think>|$)/
const EMOTICON = /:([a-zA-Z0-9_+-]+):/

// `:name:` → custom-emoticon image, else emoji shortcode, else literal `:name:`.
function emoticonSpec(emoticonBlobUrls: Accessor<Record<string, string>>) {
	return {
		pattern: EMOTICON,
		parse: (s: string) => ({name: s.slice(1, -1)}),
		toDOM: ({name}: {name: string}): Node => {
			const src = emoticonBlobUrls()[name]
			if (src) {
				const img = document.createElement("img")
				img.className = "chat-emoticon-inline"
				img.src = src
				img.alt = ":" + name + ":"
				img.title = ":" + name + ":"
				return img
			}
			const lower = name.toLowerCase()
			const alias = EMOJI_ALIASES[lower]
			if (alias) {
				const span = document.createElement("span")
				span.title = ":" + name + ":"
				span.textContent = alias
				return span
			}
			const found = EMOJI_DATA().find((e) => e.name.toLowerCase() === lower.replace(/[-_]/g, " "))
			if (found) {
				const span = document.createElement("span")
				span.title = ":" + name + ":"
				span.textContent = found.emoji
				return span
			}
			return document.createTextNode(":" + name + ":")
		},
	}
}

// Block spec for fenced code. toDOM is a defensive fallback; MessageBody intercepts
// `_chatKind:"codeblock"` and renders the streaming <CodeBlock> component instead.
const codeblockSpec = {
	_chatKind: "codeblock",
	pattern: CODE_FENCE,
	parse: (s: string) => {
		const m = s.match(CODE_FENCE)
		return {lang: m?.[1] || "", code: m?.[2] ?? ""}
	},
	toDOM: ({code}: {code: string}) => {
		const pre = document.createElement("pre")
		pre.className = "chat-code-block"
		const c = document.createElement("code")
		c.textContent = code
		pre.append(c)
		return pre
	},
}

const thinkSpec = {
	_chatKind: "think",
	pattern: THINK,
	parse: (s: string) => ({text: (s.match(THINK)?.[1] ?? "").trim()}),
	toDOM: ({text}: {text: string}) => {
		const div = document.createElement("div")
		div.className = "chat-think-block"
		div.textContent = text
		return div
	},
}

export function useChatSchema(opts: {
	selector: Accessor<PluginSelector>
	emoticonBlobUrls: Accessor<Record<string, string>>
	allowEmoticons: Accessor<boolean>
	allowThink: Accessor<boolean>
}): Accessor<CuteSchema> {
	const loaded = createLoadedPlugins("chat:syntax", syntaxPlugins, opts.selector)
	return createMemo<CuteSchema>(() => {
		const marks: Record<string, any> = {}
		const blocks: Record<string, any> = {}
		const replaces: Record<string, any> = {}
		for (const p of loaded()) {
			if (!p || !p.pattern) continue
			const bucket = p.kind === "block" ? blocks : p.kind === "replace" ? replaces : marks
			bucket[p.id] = p
		}
		// chat-internal specs (not author-facing).
		blocks.codeblock = codeblockSpec
		if (opts.allowThink()) blocks.think = thinkSpec
		if (opts.allowEmoticons()) replaces.emoji = emoticonSpec(opts.emoticonBlobUrls)
		return {marks, blocks, replaces}
	})
}
