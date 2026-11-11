import {Show, Index, For, Switch, Match, createMemo, createEffect, createSignal, onCleanup} from "solid-js"
import type {ChatMessage} from "../types"
import {isEmojiOnly} from "../lib/format-text"
import {parseMarkup} from "cute.txt/markup"
import type {CuteSchema} from "../lib/syntax-schema"
import {highlightCode} from "../lib/highlighter"
import {ensureFontLoaded} from "../lib/blob-cache"
import {resolveNamedColor} from "../lib/named-colors"
import {generateId} from "../lib/helpers"
import {useChat} from "../context/ChatContext"
import {useIdentity} from "../context/IdentityContext"
import {usePresence} from "../context/PresenceContext"
import {useTheme} from "../context/ThemeContext"
import {VoiceNote} from "./VoiceNote"
import {MessageAttachments} from "./MessageAttachments"
import {RichBlockList} from "./RichBlockView"

function ThinkBlock(props: {content: string}) {
	const [open, setOpen] = createSignal(true)
	return (
		<details class="chat-think-block" open={open()} on:toggle={(e: Event) => setOpen((e.target as HTMLDetailsElement).open)}>
			<summary>computing</summary>
			<div class="chat-think-content">{props.content}</div>
		</details>
	)
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Keep-last-good, coalesced, never-regress highlighting: the highlighted HTML is
// held in a signal, re-highlights are coalesced to one per animation frame, stale
// async results are discarded by request-id, and it never swaps back to plain
// text once there is a highlight (which would flicker while streaming).
//
// This component stays MOUNTED across streaming updates because MessageBody renders
// the parsed nodes with <Index> keyed by position — so its keep-last-good state
// survives token-by-token growth of `props.code`.
function CodeBlock(props: {lang: string; code: string}) {
	const {isLightBg} = useTheme()
	const [html, setHtml] = createSignal<string | null>(null)
	let reqId = 0
	let frame: number | undefined

	createEffect(() => {
		const code = props.code.replace(/\n$/, "")
		const lang = props.lang
		const light = isLightBg()
		// No language → leave the plain <pre> fallback in place, no shiki.
		if (!lang) return

		if (frame !== undefined) cancelAnimationFrame(frame)
		frame = requestAnimationFrame(() => {
			frame = undefined
			const id = ++reqId
			highlightCode(code, lang, light).then(out => {
				// A newer tick superseded this one — drop the stale result so we
				// never regress to older/plainer output.
				if (id !== reqId) return
				setHtml(out)
			})
		})
	})

	onCleanup(() => {
		if (frame !== undefined) cancelAnimationFrame(frame)
	})

	// Plain, escaped fallback shown only until the first highlight lands.
	const plain = () =>
		"<pre><code>" + escapeHtml(props.code.replace(/\n$/, "")) + "</code></pre>"

	return <div class="chat-code-block" innerHTML={html() ?? plain()} />
}

// Build a (non-stateful) inline DOM subtree from a cute.txt parse node: text, a
// mark (styled element + recursive children), or an inline atom (e.g. emoticon).
// Block atoms (code/think) are handled by TopNode as stable Solid components.
function buildInline(node: any): Node {
	if (node.text != null) return document.createTextNode(node.text)
	if (node.atom) {
		const out = node.atom.toDOM(node.attrs)
		return out instanceof Node ? out : document.createTextNode(out == null ? "" : String(out))
	}
	const [tag, attrs] = node.mark.toDOM(node.attrs)
	const el = document.createElement(tag)
	if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k])
	for (const child of node.children || []) el.append(buildInline(child))
	return el
}

// One top-level parse node. Code/think atoms render as stable Solid components
// (preserving shiki streaming / think toggle); everything else is inline DOM.
function TopNode(props: {node: () => any}) {
	return (
		<Switch>
			<Match when={props.node().atom?._chatKind === "codeblock"}>
				<CodeBlock lang={props.node().attrs.lang} code={props.node().attrs.code} />
			</Match>
			<Match when={props.node().atom?._chatKind === "think"}>
				<ThinkBlock content={props.node().attrs.text} />
			</Match>
			<Match when={true}>{buildInline(props.node())}</Match>
		</Switch>
	)
}

// <Index> (not <For>) so each node keeps its component instance across streaming
// growth — the reason a code block doesn't lose its highlight mid-stream.
function MessageNodes(props: {nodes: any[]}) {
	return <Index each={props.nodes}>{(node) => <TopNode node={node} />}</Index>
}

export function MessageBody(props: {
	msg: ChatMessage
	schema: CuteSchema
}) {
	const {myFonts} = useIdentity()
	const {peerFonts} = usePresence()
	const {isLightBg} = useTheme()

	const resolvedColor = createMemo(() => {
		if (!props.msg.color) return undefined
		return resolveNamedColor(props.msg.color, isLightBg())
	})

	createEffect(() => {
		if (props.msg.font) {
			ensureFontLoaded(props.msg.font, myFonts(), peerFonts())
		}
	})

	const segments = createMemo(() =>
		props.msg.text ? parseMarkup(props.msg.text, props.schema) : []
	)

	const emojiOnly = createMemo(() =>
		props.msg.text ? isEmojiOnly(props.msg.text) : false
	)

	// Spoiler reveal: click a `.chat-spoiler` to toggle `.revealed` (was InlineHtml).
	const onSpoilerClick = (e: MouseEvent) => {
		const t = e.target as HTMLElement
		if (t.classList && t.classList.contains("chat-spoiler")) t.classList.toggle("revealed")
	}

	return (
		<>
			<Show when={props.msg.text || props.msg.streaming}>
				<div
					class="chat-msg-text"
					classList={{
						"emoji-only": emojiOnly(),
						streaming: props.msg.streaming,
					}}
					style={{
						...(props.msg.font ? {"font-family": props.msg.font} : {}),
						...(resolvedColor() ? {color: resolvedColor()} : {}),
					}}
					on:click={onSpoilerClick}
				>
					<Show when={props.msg.marquee}>
						<marquee><MessageNodes nodes={segments()} /></marquee>
					</Show>
					<Show when={!props.msg.marquee}>
						<MessageNodes nodes={segments()} />
					</Show>
				</div>
			</Show>
			<Show when={props.msg.voiceUrl}>
				<VoiceNote
					voiceUrl={props.msg.voiceUrl!}
					duration={props.msg.voiceDuration || 0}
				/>
			</Show>
			<Show when={props.msg.richBlocks?.length}>
				<RichBlockList blocks={props.msg.richBlocks!} />
			</Show>
			<Show when={props.msg.quickReplies?.length}>
				<QuickReplies options={props.msg.quickReplies!} />
			</Show>
			<MessageAttachments msg={props.msg} />
		</>
	)
}

/** Clickable answer buttons for an ask_user question — sends the choice as a message. */
function QuickReplies(props: {options: string[]}) {
	const {handle, repo} = useChat()
	const {myName, myContactUrl} = useIdentity()
	const [used, setUsed] = createSignal(false)

	async function pick(opt: string) {
		if (used()) return
		setUsed(true)
		const msgData: any = {
			id: generateId(),
			name: myName(),
			text: `@computer ${opt}`,
			timestamp: Date.now(),
		}
		const cu = myContactUrl()
		if (cu) msgData.contactUrl = cu
		const mh = await repo.create2(msgData)
		handle.change((d: any) => {
			if (!d.messages) d.messages = []
			d.messages.push({ref: true, url: mh.url, timestamp: msgData.timestamp})
		})
	}

	return (
		<div class="chat-quick-replies">
			<For each={props.options}>
				{(opt) => (
					<button
						class="chat-quick-reply"
						disabled={used()}
						on:click={() => pick(opt)}>
						{opt}
					</button>
				)}
			</For>
		</div>
	)
}
