import {For, Show} from "solid-js"
import {formatTime} from "../lib/helpers"
import type {ChatMessage} from "../types"
import {useChat} from "../context/ChatContext"
import {createLoadedPlugins} from "../lib/slots"
import {messageActionPlugins} from "../lib/message-actions"

export function MessageHoverActions(props: {
	msg: ChatMessage
	rawIdx: number
	onReply: (msgId: string) => void
	onReact: (idx: number, anchorEl: HTMLElement) => void
	onDelete: (idx: number) => void
}) {
	const {selector} = useChat()
	// Active hover-bar actions from the chat:messageaction registry, with behaviour
	// (`run`/`show`) resolved inline for own built-ins or loaded from a cross-bundle
	// contribution's `.module` (e.g. chitter's react/delete). Filtered by `show`.
	const loaded = createLoadedPlugins("chat:messageaction", messageActionPlugins, selector)
	const actions = () => loaded().filter((a: any) => !a.show || a.show(props.msg))

	return (
		<div class="chat-msg-actions">
			<For each={actions()}>
				{(action: any) => (
					<button
						class="chat-msg-action-btn"
						title={action.name}
						innerHTML={action.icon}
						on:click={(e) => {
							e.stopPropagation()
							action.run({
								msg: props.msg,
								rawIdx: props.rawIdx,
								anchorEl: e.currentTarget as HTMLElement,
								onReply: props.onReply,
								onReact: props.onReact,
								onDelete: props.onDelete,
							})
						}}
					/>
				)}
			</For>
			<Show when={!props.msg._loading}>
				<span class="chat-msg-inline-time">{formatTime(props.msg.timestamp)}</span>
			</Show>
		</div>
	)
}
