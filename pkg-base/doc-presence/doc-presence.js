import {render} from "solid-js/web"
import html from "solid-js/html"
import {createSignal} from "solid-js"
import {Presence} from "@automerge/automerge-repo"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"
import {subscribe} from "@inkandswitch/patchwork-providers"

const HEARTBEAT_MS = 2_000
const PEER_TTL_MS = 10_000

// ── Presence manager (module-level) ──

const [selfInfo, setSelfInfo] = createSignal(null)
const [focused, setFocused] = createSignal(document.hasFocus())

let myContactUrl = null
const sessions = new Map()
let currentDocUrl = null
let unsubscribeView = null

let loadingSelf = null
function loadSelf() {
	if (!loadingSelf) loadingSelf = loadSelfOnce()
	return loadingSelf
}

async function loadSelfOnce() {
	let contactUrl
	while (!(contactUrl = window.accountDocHandle?.doc()?.contactUrl)) {
		await new Promise(resolve => setTimeout(resolve, 250))
	}
	myContactUrl = contactUrl
	const contactHandle = await window.repo.find(myContactUrl)
	function refresh() {
		const c = contactHandle.doc()
		if (!c) return
		setSelfInfo({
			name: c.type === "registered" ? c.name : "Anonymous",
			color: c.color || null,
			avatarUrl: (c.type === "registered" && c.avatarUrl) || null,
		})
		for (const session of sessions.values()) broadcastIdentity(session)
	}
	refresh()
	contactHandle.on("change", refresh)
}

function localState() {
	const s = selfInfo()
	const state = {
		contactUrl: myContactUrl,
		name: s?.name || "Anonymous",
		color: s?.color || "#888",
		focused: focused(),
	}
	if (s?.avatarUrl) state.avatarUrl = s.avatarUrl
	return state
}

function broadcastIdentity(session) {
	if (!session.presence.running) return
	const state = localState()
	for (const channel of ["name", "color", "avatarUrl"]) {
		if (channel in state) session.presence.broadcast(channel, state[channel])
	}
}

function peersByContact(presence) {
	const byContact = new Map()
	for (const peer of presence.getPeerStates().peers) {
		const value = peer.value
		if (!value?.contactUrl || value.contactUrl === myContactUrl) continue
		const existing = byContact.get(value.contactUrl)
		if (!existing || peer.lastUpdateAt > existing.lastUpdateAt) {
			byContact.set(value.contactUrl, peer)
		}
	}
	return [...byContact.values()]
}

const PEER_EVENTS = ["update", "snapshot", "goodbye", "pruned"]

function joinDoc(handle) {
	const url = handle.url
	if (sessions.has(url)) return sessions.get(url)

	const [peers, setPeers] = createSignal([])
	const presence = new Presence({handle})
	const refresh = () => setPeers(peersByContact(presence))
	for (const event of PEER_EVENTS) presence.on(event, refresh)

	const session = {handle, presence, peers, refresh}
	sessions.set(url, session)

	loadSelf().then(() => {
		if (sessions.get(url) !== session) return
		presence.start({
			initialState: localState(),
			heartbeatMs: HEARTBEAT_MS,
			peerTtlMs: PEER_TTL_MS,
		})
	})

	return session
}

function leaveDoc(handle) {
	const url = handle.url
	const session = sessions.get(url)
	if (!session) return
	session.presence.stop()
	for (const event of PEER_EVENTS) session.presence.off(event, session.refresh)
	sessions.delete(url)
}

function broadcastFocus() {
	for (const session of sessions.values()) {
		if (session.presence.running) {
			session.presence.broadcast("focused", focused())
		}
	}
}

window.addEventListener("focus", () => {
	setFocused(true)
	broadcastFocus()
})
window.addEventListener("blur", () => {
	setFocused(false)
	broadcastFocus()
})
window.addEventListener("beforeunload", () => {
	for (const session of sessions.values()) session.presence.stop()
})

// ── Track selected doc via SelectedDocProvider ──

async function onSelectedDocChange(newUrl) {
	if (newUrl === currentDocUrl) return

	if (currentDocUrl) {
		const old = sessions.get(currentDocUrl)
		if (old) leaveDoc(old.handle)
	}

	currentDocUrl = newUrl

	if (newUrl && window.repo) {
		loadSelf()
		const handle = await window.repo.find(newUrl)
		// selection may have moved on while we awaited; don't join a stale doc
		if (currentDocUrl !== newUrl) return
		joinDoc(handle)
	}
}

function connectToSelectedDocProvider(element) {
	if (unsubscribeView) return
	unsubscribeView = subscribe(element, {type: "patchwork:selected-view"}, view => {
		onSelectedDocChange(view?.url)
	})
}

loadSelf()

// ── Tool (rendering only) ──

function DocPresence(handle, element) {
	connectToSelectedDocProvider(element)
	const session = joinDoc(handle)

	function face(entry, fadedFn) {
		const color = entry.color || "#888"
		const initial = (entry.name || "?")[0].toUpperCase()
		const imgUrl = entry.avatarUrl
			? automergeUrlToServiceWorkerUrl(entry.avatarUrl)
			: null
		return html`<div
			class="doc-presence-face"
			style=${() => {
				let s = `--face-color:${color}; opacity:${fadedFn() ? 0.35 : 1};`
				if (imgUrl)
					s += ` background-image: url("${imgUrl}"); color: transparent;`
				return s
			}}
			title=${entry.name}
		>
			${initial}
		</div>`
	}

	const style = document.createElement("style")
	style.textContent = `
		.doc-presence {
			display: flex;
			align-items: center;
			gap: 2px;
			height: 100%;
		}
		.doc-presence-face {
			width: 22px;
			height: 22px;
			border-radius: 50%;
			border: 2px solid var(--face-color, #888);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 10px;
			font-weight: 600;
			line-height: 1;
			overflow: hidden;
			flex-shrink: 0;
			transition: opacity max(1ms, calc(0.3s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))) ease;
			background-color: var(--color-base-200, #eee);
			background-size: cover;
			background-position: center;
			color: var(--color-base-content, #333);
		}
	`
	element.appendChild(style)

	const dispose = render(
		() => html`<div class="doc-presence">
			${() => {
				const s = selfInfo()
				if (!s) return null
				return face(s, () => !focused())
			}}
			${() =>
				session.peers().map(p => face(p.value, () => !p.value.focused))}
		</div>`,
		element,
	)

	return () => {
		leaveDoc(handle)
		style.remove()
		dispose()
	}
}

export const plugins = [
	{
		type: "patchwork:tool",
		id: "doc-presence",
		tags: ["titlebar-tool"],
		name: "Presence",
		icon: "Users",
		supportedDatatypes: "*",
		forTitleBar: true,
		unlisted: true,
		async load() {
			return DocPresence
		},
	},
]
