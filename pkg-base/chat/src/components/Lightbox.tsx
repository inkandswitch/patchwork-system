import {Show} from "solid-js"

export function Lightbox(props: {
	src: string | null
	type?: "image" | "video"
	onClose: () => void
}) {
	function handleClick(e: MouseEvent) {
		if (e.target === e.currentTarget) props.onClose()
	}

	return (
		<div
			class="chat-lightbox"
			classList={{show: !!props.src}}
			on:click={handleClick}
		>
			<Show when={props.src}>
				<Show
					when={props.type === "video"}
					fallback={<img src={props.src!} />}
				>
					<video src={props.src!} controls autoplay />
				</Show>
			</Show>
		</div>
	)
}
