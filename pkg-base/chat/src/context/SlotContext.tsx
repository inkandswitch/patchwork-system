// The cross-bundle extension seam. `SlotContext` is a SINGLE explicit object
// handed to every slot renderer as an argument — slot components (which may be
// authored in another bundle, e.g. `chitter`) must NOT call useChat/useIdentity/
// usePresence, because `createContext` identity differs per bundle and those hooks
// would return undefined. So we aggregate the three in-bundle contexts (plus the
// base capabilities ChatRoot owns) into one plain object and pass it down.
import {
	createContext,
	useContext,
	type ParentComponent,
	type Accessor,
	type JSX,
} from "solid-js"
import {For} from "solid-js/web"
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {useChat} from "./ChatContext"
import {useIdentity} from "./IdentityContext"
import {usePresence} from "./PresenceContext"
import {createFeatureSlots, type SlotEntry} from "../lib/slots"

export interface EmojiPickerState {
	open: boolean
	targetIdx: number | null
	anchorEl: HTMLElement | null
}

// Capabilities the base (ChatRoot) owns and exposes to slots. Sidebar/pin/emoji-
// picker/reply/dialogs all stay base-owned (data + signals); slots drive them.
export interface SlotBaseCaps {
	isContext: Accessor<boolean>
	sidebarVisible: Accessor<boolean>
	setSidebarVisible: (v: boolean) => void
	toggleSidebar: () => void
	pinDoc: (url: AutomergeUrl, toolId?: string, name?: string) => void
	emojiPickerState: Accessor<EmojiPickerState>
	openEmojiPicker: (idx: number, anchorEl: HTMLElement) => void
	closeEmojiPicker: () => void
	replyToId: Accessor<string | null>
	setReplyToId: (v: string | null) => void
	showEmoticonDialog: Accessor<boolean>
	setShowEmoticonDialog: (v: boolean) => void
	showFontDialog: Accessor<boolean>
	setShowFontDialog: (v: boolean) => void
	openLightbox: (src: string, type?: string) => void
	computerActive: Accessor<boolean>
}

export interface SlotContextValue {
	chat: ReturnType<typeof useChat>
	identity: ReturnType<typeof useIdentity>
	presence: ReturnType<typeof usePresence>
	base: SlotBaseCaps
	slotsFor: (slotId: string) => SlotEntry[]
}

const SlotCtx = createContext<SlotContextValue>()

// Mounted INSIDE ChatProvider/IdentityProvider/PresenceProvider so the three hooks
// resolve. `caps` is threaded from ChatRoot's own scope.
export const SlotProvider: ParentComponent<{caps: SlotBaseCaps}> = (props) => {
	const chat = useChat()
	const identity = useIdentity()
	const presence = usePresence()
	const slotMap = createFeatureSlots(chat.selector)

	const value: SlotContextValue = {
		chat,
		identity,
		presence,
		base: props.caps,
		slotsFor: (slotId) => slotMap()[slotId] ?? [],
	}

	return <SlotCtx.Provider value={value}>{props.children}</SlotCtx.Provider>
}

// For same-bundle mount points that need the ctx object to hand to renderers.
export function useSlotContext(): SlotContextValue {
	const ctx = useContext(SlotCtx)
	if (!ctx) throw new Error("useSlotContext must be used within SlotProvider")
	return ctx
}

// Render every renderer contributed to a named slot. `extra` is mount-point-local
// data forwarded to each renderer as its second argument.
export function Slot(props: {name: string; extra?: any}): JSX.Element {
	const ctx = useSlotContext()
	return (
		<For each={ctx.slotsFor(props.name)}>
			{(entry) => entry.render(ctx, props.extra)}
		</For>
	)
}
