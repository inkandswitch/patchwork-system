import {Show} from "solid-js"
import {usePresence} from "../context/PresenceContext"

export function TypingBar() {
	const {typingUsers} = usePresence()

	const typingText = () => {
		const users = typingUsers()
		if (users.length === 0) return ""
		if (users.length === 1) return users[0] + " is typing\u2026"
		return users.join(", ") + " are typing\u2026"
	}

	return (
		<div class="chat-typing-bar">
			<Show when={typingText()}>{(text) => text()}</Show>
		</div>
	)
}
