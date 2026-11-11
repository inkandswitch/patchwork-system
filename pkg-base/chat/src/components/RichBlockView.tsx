import {createSignal, createResource, For, Show} from "solid-js"
import type {RichBlock} from "../types"
import {highlightCode} from "../lib/highlighter"
import {useTheme} from "../context/ThemeContext"

export function RichBlockList(props: {blocks: RichBlock[]}) {
	return (
		<div class="chat-rich-blocks">
			<For each={props.blocks}>
				{(block) => <RichBlockView block={block} />}
			</For>
		</div>
	)
}

function RichBlockView(props: {block: RichBlock}) {
	const {isLightBg} = useTheme()
	const [open, setOpen] = createSignal(false)

	const label = () => {
		if (props.block.type === "tool-call") {
			const firstLine = props.block.content.trim().split("\n")[0]
			const toolMatch = firstLine.match(/^tool:\s*(.+)/)
			return toolMatch ? "tool: " + toolMatch[1] : "tool-call"
		}
		if (props.block.type === "patchwork-tool") {
			return "patchwork-tool"
		}
		return props.block.type
	}

	const lang = () => {
		if (props.block.type === "patchwork-tool") return "javascript"
		if (props.block.type === "tool-call") return "yaml"
		return "text"
	}

	const [highlighted] = createResource(
		() => ({content: props.block.content, lang: lang(), light: isLightBg()}),
		async ({content, lang, light}) => highlightCode(content.trim(), lang, light)
	)

	const [resultHighlighted] = createResource(
		() => props.block.result ? {content: props.block.result, lang: "json", light: isLightBg()} : null,
		async (params) => params ? highlightCode(params.content.trim(), params.lang, params.light) : ""
	)

	return (
		<div class="chat-rich-block" classList={{open: open()}}>
			<button
				class="chat-rich-block-header"
				on:click={() => setOpen(!open())}
			>
				<svg class="chat-rich-block-chevron" viewBox="0 0 10 10" width="10" height="10">
					<path d="M3 2L7 5L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
				<span class="chat-rich-block-label">{label()}</span>
			</button>
			<Show when={open()}>
				<div class="chat-rich-block-body">
					<Show
						when={highlighted()}
						fallback={<pre class="chat-rich-block-code"><code>{props.block.content.trim()}</code></pre>}
					>
						<div class="chat-rich-block-code" innerHTML={highlighted()} />
					</Show>
					<Show when={props.block.result}>
						<div class="chat-rich-block-result-label">Result</div>
						<Show
							when={resultHighlighted()}
							fallback={<pre class="chat-rich-block-code"><code>{props.block.result}</code></pre>}
						>
							<div class="chat-rich-block-code" innerHTML={resultHighlighted()} />
						</Show>
					</Show>
				</div>
			</Show>
		</div>
	)
}
