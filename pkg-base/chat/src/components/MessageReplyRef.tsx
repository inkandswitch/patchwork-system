import {Show, createMemo} from "solid-js"
import type {ChatMessage} from "../types"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"

export function MessageReplyRef(props: {
	replyToMsg: ChatMessage | undefined
	onClick?: () => void
}) {
	const msg = () => props.replyToMsg

	const avatarSrc = createMemo(() => {
		const url = msg()?.avatarUrl
		return url ? automergeUrlToServiceWorkerUrl(url as any) : null
	})

	return (
		<Show when={msg()}>
			<div class="chat-msg-reply-ref" on:click={props.onClick}>
				<span class="chat-msg-reply-ref-avatar">
					<Show when={avatarSrc()}>
						<img src={avatarSrc()!} />
					</Show>
				</span>
				<span class="chat-msg-reply-ref-name">{msg()!.name}</span>
				<span class="chat-msg-reply-ref-text">
					{msg()!.text || "(attachment)"}
				</span>
			</div>
		</Show>
	)
}
