import {
	createContext,
	useContext,
	createSignal,
	createMemo,
	onMount,
	onCleanup,
	type ParentComponent,
	type Accessor,
} from "solid-js"
import type {DocHandle, AutomergeUrl} from "@automerge/automerge-repo/slim"
import type {ChatDoc, PresenceInfo, PresencePayload} from "../types"
import {useIdentity} from "./IdentityContext"

const PRESENCE_TIMEOUT = 30000
const TYPING_TIMEOUT = 3000

interface PresenceContextValue {
	presenceMap: Accessor<Map<string, PresenceInfo>>
	broadcastPresence: (typing: boolean) => void
	isFocused: Accessor<boolean>
	typingUsers: Accessor<string[]>
	peerEmoticons: Accessor<Map<string, Record<string, AutomergeUrl>>>
	peerFonts: Accessor<Map<string, Record<string, AutomergeUrl>>>
}

const PresenceCtx = createContext<PresenceContextValue>()

export const PresenceProvider: ParentComponent<{
	handle: DocHandle<ChatDoc>
}> = (props) => {
	const {myName, myAvatarUrl, myColor, myEmoticons, myFonts} = useIdentity()
	const [presenceMap, setPresenceMap] = createSignal(new Map<string, PresenceInfo>())
	const [isFocused, setIsFocused] = createSignal(document.hasFocus())
	const [peerEmoticons, setPeerEmoticons] = createSignal(
		new Map<string, Record<string, AutomergeUrl>>()
	)
	const [peerFonts, setPeerFonts] = createSignal(
		new Map<string, Record<string, AutomergeUrl>>()
	)

	const typingUsers = createMemo(() => {
		const now = Date.now()
		const typers: string[] = []
		const name = myName()
		for (const [n, info] of presenceMap()) {
			if (n === name || n.toLowerCase() === "computer") continue
			if (info.typing && now - info.timestamp < TYPING_TIMEOUT) {
				typers.push(n)
			}
		}
		return typers
	})

	function broadcastPresence(typing: boolean) {
		try {
			const payload: PresencePayload = {
				type: "presence",
				name: myName(),
				typing: !!typing,
				avatarUrl: myAvatarUrl() || undefined,
				color: myColor() || undefined,
				active: isFocused(),
				timestamp: Date.now(),
			}
			const em = myEmoticons()
			if (Object.keys(em).length > 0) payload.emoticons = em
			const fn = myFonts()
			if (Object.keys(fn).length > 0) payload.fonts = fn
			props.handle.broadcast(payload)
		} catch (e) {}
	}

	function onEphemeralMessage(data: {message: any}) {
		const msg = data.message as PresencePayload
		if (msg?.type === "presence") {
			setPresenceMap(prev => {
				const next = new Map(prev)
				next.set(msg.name, {
					timestamp: msg.timestamp,
					typing: msg.typing,
					avatarUrl: msg.avatarUrl,
					color: msg.color,
					active: msg.active,
				})
				return next
			})
			if (msg.emoticons) {
				setPeerEmoticons(prev => {
					const next = new Map(prev)
					next.set(msg.name, msg.emoticons!)
					return next
				})
			}
			if (msg.fonts) {
				setPeerFonts(prev => {
					const next = new Map(prev)
					next.set(msg.name, msg.fonts!)
					return next
				})
			}
		}
	}

	onMount(() => {
		props.handle.on("ephemeral-message", onEphemeralMessage)

		const onVisible = () => {
			setIsFocused(!document.hidden)
			broadcastPresence(false)
		}
		const onFocus = () => {
			setIsFocused(true)
			broadcastPresence(false)
		}
		const onBlur = () => {
			setIsFocused(false)
			broadcastPresence(false)
		}
		document.addEventListener("visibilitychange", onVisible)
		window.addEventListener("focus", onFocus)
		window.addEventListener("blur", onBlur)

		const presenceInterval = setInterval(() => {
			broadcastPresence(false)
			setPresenceMap(prev => {
				const now = Date.now()
				const next = new Map(prev)
				for (const [n, info] of next) {
					if (now - info.timestamp > PRESENCE_TIMEOUT) next.delete(n)
				}
				return next
			})
		}, 10000)

		setTimeout(() => broadcastPresence(false), 500)

		onCleanup(() => {
			props.handle.off("ephemeral-message", onEphemeralMessage)
			clearInterval(presenceInterval)
			document.removeEventListener("visibilitychange", onVisible)
			window.removeEventListener("focus", onFocus)
			window.removeEventListener("blur", onBlur)
		})
	})

	return (
		<PresenceCtx.Provider
			value={{
				presenceMap,
				broadcastPresence,
				isFocused,
				typingUsers,
				peerEmoticons,
				peerFonts,
			}}
		>
			{props.children}
		</PresenceCtx.Provider>
	)
}

export function usePresence(): PresenceContextValue {
	const ctx = useContext(PresenceCtx)
	if (!ctx) throw new Error("usePresence must be used within PresenceProvider")
	return ctx
}
