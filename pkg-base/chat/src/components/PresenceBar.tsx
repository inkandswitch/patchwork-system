import {For, Show, createSignal, createMemo, onMount, onCleanup} from "solid-js"
import {useChat} from "../context/ChatContext"
import {useIdentity} from "../context/IdentityContext"
import {usePresence} from "../context/PresenceContext"
import {SVG_ICONS} from "../lib/svg-icons"
import {Slot} from "../context/SlotContext"
import {NotifyMenu} from "./NotifyMenu"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"

const computerPngUrl = new URL("../../computer.png", import.meta.url).href

export function PresenceBar(props: {
	onToggleSidebar?: () => void
	computerActive?: boolean
}) {
	const {doc, hasFeature} = useChat()
	const {myName, myAvatarUrl} = useIdentity()
	const {presenceMap, isFocused} = usePresence()

	const [showNotify, setShowNotify] = createSignal(false)
	const [notifyRect, setNotifyRect] = createSignal<DOMRect | null>(null)
	let notifyBtnRef!: HTMLButtonElement

	const presenceUsers = createMemo(() => {
		const result: {
			name: string
			avatarSrc?: string
			active: boolean
			isComputer?: boolean
			tooltip?: string
		}[] = []
		// Self
		const myAvUrl = myAvatarUrl()
		result.push({
			name: myName(),
			avatarSrc: myAvUrl ? automergeUrlToServiceWorkerUrl(myAvUrl) : undefined,
			active: isFocused(),
		})
		// Peers
		for (const [name, info] of presenceMap()) {
			if (name === myName()) continue
			result.push({
				name,
				active: info.active,
				avatarSrc: info.avatarUrl ? automergeUrlToServiceWorkerUrl(info.avatarUrl as any) : undefined,
			})
		}
		// Computer — tooltip surfaces who owns (hosts) it and which model it runs.
		if (props.computerActive) {
			const d = doc() as any
			const owner = d?.computerOwner
			const model = d?.computerModel
			const tooltip =
				"Computer" +
				(owner ? " — owned by " + owner : " — unclaimed") +
				(model ? " · running " + model : "") +
				(owner ? "\n(/computer own to take over)" : "")
			result.push({
				name: "computer",
				active: true,
				avatarSrc: computerPngUrl,
				isComputer: true,
				tooltip,
			})
		}
		return result
	})

	// Close popovers on outside click
	function handleDocClick(e: MouseEvent) {
		if (showNotify() && notifyBtnRef && !notifyBtnRef.contains(e.target as Node)) {
			const menu = document.querySelector(".chat-notify-menu")
			if (!menu?.contains(e.target as Node)) setShowNotify(false)
		}
	}

	onMount(() => document.addEventListener("click", handleDocClick, true))
	onCleanup(() => document.removeEventListener("click", handleDocClick, true))

	function toggleNotify() {
		if (!showNotify()) {
			setNotifyRect(notifyBtnRef.getBoundingClientRect())
		}
		setShowNotify(!showNotify())
	}

	return (
		<div class="chat-presence-bar" title={doc()?.title || "Chat"}>
			<For each={presenceUsers()}>
				{(user) => (
					<div
						class="chat-presence-user"
						classList={{away: !user.active}}
						title={user.tooltip || user.name}>
						<span class="chat-presence-avatar">
							<Show when={user.avatarSrc} fallback={(user.name || "?")[0].toUpperCase()}>
								<img src={user.avatarSrc} />
							</Show>
						</span>
						{user.name}
					</div>
				)}
			</For>
			<div style="margin-left:auto;display:flex;align-items:center;gap:2px">
				<Show when={hasFeature("notifications")}>
					<button
						ref={notifyBtnRef}
						class="chat-notify-btn"
						on:click={toggleNotify}
						innerHTML={SVG_ICONS.bellOutline}
					/>
					<Show when={showNotify() && notifyRect()}>
						<NotifyMenu
							anchorRect={notifyRect()!}
							onClose={() => setShowNotify(false)}
						/>
					</Show>
				</Show>
				<Slot name="presence-bar-actions" />
				<Show when={hasFeature("sidebar")}>
					<button
						class="chat-sidebar-toggle-btn"
						title="Toggle sidebar"
						on:click={() => props.onToggleSidebar?.()}
						innerHTML={SVG_ICONS.sidebar}
					/>
				</Show>
			</div>
		</div>
	)
}
