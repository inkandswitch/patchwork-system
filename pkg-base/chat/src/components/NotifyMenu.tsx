import {createSignal} from "solid-js"

export function NotifyMenu(props: {onClose: () => void; anchorRect: DOMRect}) {
	const [soundEnabled, setSoundEnabled] = createSignal(
		localStorage.getItem("chat-sound-enabled") !== "false"
	)
	const [notificationsEnabled, setNotificationsEnabled] = createSignal(
		localStorage.getItem("chat-notifications-enabled") === "true"
	)

	function toggleSound() {
		const next = !soundEnabled()
		setSoundEnabled(next)
		localStorage.setItem("chat-sound-enabled", next ? "true" : "false")
	}

	async function toggleNotifications() {
		if (typeof Notification === "undefined") return
		if (!notificationsEnabled()) {
			const perm =
				Notification.permission === "granted"
					? "granted"
					: await Notification.requestPermission()
			if (perm === "granted") {
				setNotificationsEnabled(true)
				localStorage.setItem("chat-notifications-enabled", "true")
			}
		} else {
			setNotificationsEnabled(false)
			localStorage.setItem("chat-notifications-enabled", "false")
		}
	}

	return (
		<div
			class="chat-notify-menu show"
			style={{
				position: "fixed",
				top: (props.anchorRect.bottom + 4) + "px",
				right: (window.innerWidth - props.anchorRect.right) + "px",
				"z-index": "var(--studio-layer-dropdown, 200)",
			}}
			on:click={(e) => e.stopPropagation()}
		>
			<div class="chat-notify-menu-row" on:click={toggleSound}>
				Sound
				<button
					class="chat-notify-toggle"
					classList={{on: soundEnabled()}}
				/>
			</div>
			<div class="chat-notify-menu-row" on:click={toggleNotifications}>
				Desktop notifications
				<button
					class="chat-notify-toggle"
					classList={{on: notificationsEnabled()}}
				/>
			</div>
		</div>
	)
}
