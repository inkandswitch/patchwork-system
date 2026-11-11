import {
	createContext,
	useContext,
	createSignal,
	createEffect,
	onMount,
	onCleanup,
	type ParentComponent,
	type Accessor,
} from "solid-js"
import type {DocHandle, AutomergeUrl} from "@automerge/automerge-repo/slim"
import {isValidAutomergeUrl} from "@automerge/automerge-repo/slim"
import type {ChatProfileDoc} from "../types"
import {getRepo} from "../lib/repo"
import {useChat} from "./ChatContext"
import {subscribe} from "../lib/selected-doc"

interface IdentityContextValue {
	myName: Accessor<string>
	myContactUrl: Accessor<AutomergeUrl | null>
	myFont: Accessor<string | null>
	myAvatarUrl: Accessor<AutomergeUrl | null>
	myColor: Accessor<string | null>
	chatProfileHandle: Accessor<DocHandle<ChatProfileDoc> | null>
	contactHandle: Accessor<DocHandle<any> | null>
	myEmoticons: Accessor<Record<string, AutomergeUrl>>
	setMyEmoticons: (v: Record<string, AutomergeUrl>) => void
	myFonts: Accessor<Record<string, AutomergeUrl>>
	setMyFonts: (v: Record<string, AutomergeUrl>) => void
}

const IdentityCtx = createContext<IdentityContextValue>()

/** Normalise whatever the patchwork:contact provider posts (url string, array of
 * urls, or {url}) down to a single valid AutomergeUrl. */
function normalizeContactUrl(v: unknown): AutomergeUrl | null {
	let candidate: unknown = v
	if (Array.isArray(candidate)) candidate = candidate[0]
	if (candidate && typeof candidate === "object" && "url" in (candidate as any)) {
		candidate = (candidate as any).url
	}
	return typeof candidate === "string" && isValidAutomergeUrl(candidate)
		? (candidate as AutomergeUrl)
		: null
}

export const IdentityProvider: ParentComponent = (props) => {
	const {element} = useChat()

	const [myName, setMyName] = createSignal("Anonymous")
	const [myContactUrl, setMyContactUrl] = createSignal<AutomergeUrl | null>(null)
	const [myFont, setMyFont] = createSignal<string | null>(null)
	const [myAvatarUrl, setMyAvatarUrl] = createSignal<AutomergeUrl | null>(null)
	const [myColor, setMyColor] = createSignal<string | null>(null)
	const [chatProfileHandle, setChatProfileHandle] = createSignal<DocHandle<ChatProfileDoc> | null>(null)
	const [contactHandle, setContactHandle] = createSignal<DocHandle<any> | null>(null)
	const [myEmoticons, setMyEmoticons] = createSignal<Record<string, AutomergeUrl>>({})
	const [myFonts, setMyFonts] = createSignal<Record<string, AutomergeUrl>>({})

	// The current user's contact comes from the host's `patchwork:contact` provider
	// (the comments-view pattern) — reusing our vanilla provider-subscribe. If the
	// host doesn't answer, we fall back to window.accountDocHandle.contactUrl below.
	const providedContact = subscribe<unknown>(
		element,
		{type: "patchwork:contact"},
		undefined
	)

	let appliedUrl: AutomergeUrl | null = null
	let offContact: (() => void) | null = null
	let offProfile: (() => void) | null = null

	async function applyContact(contactUrl: AutomergeUrl) {
		if (appliedUrl === contactUrl) return
		appliedUrl = contactUrl
		try {
			const repo = getRepo()
			if (!repo) return
			const adh = (window as any).accountDocHandle

			setMyContactUrl(contactUrl)
			const ch = await repo.find(contactUrl)
			setContactHandle(ch)
			const cd = ch.doc() as any
			if (!cd) return
			if (cd.name) setMyName(cd.name)
			if (cd.avatarUrl) setMyAvatarUrl(cd.avatarUrl)
			if (cd.color) setMyColor(cd.color)

			// Resolve the chat profile doc. Prefer the contact's own chatProfileUrl
			// so identity doesn't depend on the account doc; fall back to the
			// account doc's, migrating the old contact.chat field if present.
			let profileHandle: DocHandle<ChatProfileDoc>
			if (cd.chatProfileUrl) {
				profileHandle = await repo.find(cd.chatProfileUrl)
			} else if (adh?.doc?.()?.chatProfileUrl) {
				profileHandle = await repo.find(adh.doc().chatProfileUrl)
				ch.change((d: any) => {
					d.chatProfileUrl = profileHandle.url
				})
			} else {
				const initialProfile: any = {readPositions: {}}
				if (cd.chat?.font) initialProfile.font = cd.chat.font
				profileHandle = await repo.create2(initialProfile)
				ch.change((d: any) => {
					d.chatProfileUrl = profileHandle.url
					if (d.chat) delete d.chat
				})
			}
			setChatProfileHandle(profileHandle)

			const profile = profileHandle.doc()
			if (profile?.font) setMyFont(profile.font)
			if (profile?.emoticons) setMyEmoticons({...profile.emoticons})
			if (profile?.fonts) setMyFonts({...profile.fonts})

			// Subscribe to contact doc changes (name, avatar, colour) — live.
			const onContactChange = () => {
				const updated = ch.doc() as any
				if (!updated) return
				if (updated.name) setMyName(updated.name)
				if (updated.avatarUrl && updated.avatarUrl !== myAvatarUrl()) {
					setMyAvatarUrl(updated.avatarUrl)
				}
				if (updated.color) setMyColor(updated.color)
			}
			ch.on("change", onContactChange)
			offContact?.()
			offContact = () => ch.off("change", onContactChange)

			// Subscribe to profile doc changes (font, emoticons, fonts).
			const onProfileChange = () => {
				const updated = profileHandle.doc() as any
				if (!updated) return
				setMyFont(updated.font || null)
				if (updated.emoticons) setMyEmoticons({...updated.emoticons})
				if (updated.fonts) setMyFonts({...updated.fonts})
			}
			profileHandle.on("change", onProfileChange)
			offProfile?.()
			offProfile = () => profileHandle.off("change", onProfileChange)
		} catch (e) {
			console.warn("[Chat] resolve contact:", e)
			appliedUrl = null // allow a retry via the fallback path
		}
	}

	// Provider path: apply whenever the host posts a contact url.
	createEffect(() => {
		const url = normalizeContactUrl(providedContact())
		if (url) applyContact(url)
	})

	// Fallback path: if the provider hasn't answered shortly after mount, resolve
	// via the account doc directly (the pre-existing behaviour).
	onMount(() => {
		setTimeout(async () => {
			if (appliedUrl) return
			try {
				const repo = getRepo()
				if (!repo) return
				const adh = (window as any).accountDocHandle
				if (!adh) return
				const readyAdh = await repo.find(adh.url)
				const ad = readyAdh.doc() as any
				if (ad?.contactUrl && !appliedUrl) applyContact(ad.contactUrl)
			} catch (e) {
				console.warn("[Chat] resolve account:", e)
			}
		}, 400)
	})

	onCleanup(() => {
		offContact?.()
		offProfile?.()
	})

	return (
		<IdentityCtx.Provider
			value={{
				myName,
				myContactUrl,
				myFont,
				myAvatarUrl,
				myColor,
				chatProfileHandle,
				contactHandle,
				myEmoticons,
				setMyEmoticons,
				myFonts,
				setMyFonts,
			}}
		>
			{props.children}
		</IdentityCtx.Provider>
	)
}

export function useIdentity(): IdentityContextValue {
	const ctx = useContext(IdentityCtx)
	if (!ctx) throw new Error("useIdentity must be used within IdentityProvider")
	return ctx
}
