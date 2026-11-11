import {Show, createMemo, createSignal} from "solid-js"
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"

const computerPngUrl = new URL("../../computer.png", import.meta.url).href

// Shared per-session cat ears state (by author name)
const [catEarsSet, setCatEarsSet] = createSignal(new Set<string>())

function toggleCatEars(name: string) {
	setCatEarsSet(prev => {
		const next = new Set(prev)
		if (next.has(name)) next.delete(name)
		else next.add(name)
		return next
	})
}

export function Avatar(props: {
	name: string
	contactUrl?: AutomergeUrl
	avatarUrl?: AutomergeUrl
	gifSelfieUrl?: AutomergeUrl
	isComputer?: boolean
	size?: number
	onClick?: () => void
}) {
	const size = () => props.size || 40

	const imgUrl = createMemo(() => {
		const url = props.gifSelfieUrl || props.avatarUrl
		return url ? automergeUrlToServiceWorkerUrl(url) : null
	})

	const isGif = () => !!props.gifSelfieUrl

	const initials = () => (props.name || "?")[0].toUpperCase()

	return (
		<div
			class="chat-avatar"
			classList={{
				"cat-ears": catEarsSet().has(props.name),
				"gif-selfie": isGif(),
				"computer": props.isComputer,
			}}
			style={{width: size() + "px", height: size() + "px"}}
			on:click={() => {
				toggleCatEars(props.name)
				props.onClick?.()
			}}
		>
			<Show
				when={imgUrl()}
				fallback={
					<Show when={props.isComputer} fallback={initials()}>
						<img src={computerPngUrl} alt="Computer" />
					</Show>
				}
			>
				<img src={imgUrl()!} alt={props.name} />
			</Show>
		</div>
	)
}
