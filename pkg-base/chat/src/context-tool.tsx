// The `context-tool` variant of chitterchatter — the "chitchat" sidebar.
//
// Registered as a `patchwork:component` (render signature `(element) => cleanup`,
// no bound doc). It reads whatever document the user has FOCUSED from the
// selected-doc provider, stores its chat in a separate doc referenced from
// `focusedDoc['@patchwork'].chitchat` (created on first use), and renders the
// chat UI — streamlined (no sidebar) and with the computer pointed at editing
// the focused document instead of building tools.
//
// The set of plugins a *new* chitchat starts with is remembered per-account via
// the `patchwork:tool-storage` provider (`{defaultPlugins}`, initialised to just
// `["computer"]`). Whenever a chitchat's plugin set changes (e.g. via `/plugin`),
// that new set is written back as the remembered default for future chitchats.
import {render} from "solid-js/web"
import {createSignal, createEffect, onCleanup, Show} from "solid-js"
import type {Repo, DocHandle, AutomergeUrl} from "@automerge/automerge-repo/slim"
import {ChatRoot} from "./components/ChatRoot"
import {selectedDocUrl, toolStorageUrl} from "./lib/selected-doc"
import {setRepo} from "./lib/repo"
import type {ChatDoc} from "./types"

interface ToolStorageDoc {
	defaultPlugins?: string[]
}

const DEFAULT_CHITCHAT_PLUGINS = ["computer", "model"]
const OLD_DEFAULT_CHITCHAT_PLUGINS = ["computer"]

function isOldDefaultChitchatPlugins(plugins: unknown): plugins is string[] {
	return (
		Array.isArray(plugins) &&
		plugins.length === OLD_DEFAULT_CHITCHAT_PLUGINS.length &&
		plugins.every((p, i) => p === OLD_DEFAULT_CHITCHAT_PLUGINS[i])
	)
}

/** Find (or create + link) the chat doc stored on the focused document, seeding a
 * new one's plugin set from the remembered default. */
async function ensureChitchat(
	repo: Repo,
	targetUrl: AutomergeUrl,
	defaultPlugins: string[]
): Promise<DocHandle<ChatDoc>> {
	const target = await repo.find(targetUrl)
	const existing = (target.doc() as any)?.["@patchwork"]?.chitchat
	if (existing) {
		const chat = (await repo.find(existing)) as DocHandle<ChatDoc>
		chat.change((d: any) => {
			const isMissingPlugins = !Array.isArray(d.plugins)
			if (isMissingPlugins) d.plugins = defaultPlugins.slice()
			else if (isOldDefaultChitchatPlugins(d.plugins)) {
				d.plugins = DEFAULT_CHITCHAT_PLUGINS.slice()
			}
			if (isMissingPlugins && d["@patchwork"]?.type === "chitterchatter") {
				d["@patchwork"].type = "chat"
			}
		})
		return chat
	}

	const targetTitle = (target.doc() as any)?.title
	const created = await repo.create2({
		title: "chat: " + (targetTitle || "document"),
		messages: [],
		docs: [],
		// Seed the plugin set from the user's remembered chitchat default (starts as
		// just the computer). The computer is auto-invited below.
		plugins: defaultPlugins.slice(),
		"@patchwork": {type: "chat"},
		// Auto-invite the computer (ChatRoot's onMount claims the host when
		// hasComputer is set) — but it stays off nosey, so it only replies when
		// @mentioned or replied to.
		hasComputer: true,
	} as any)
	// Resolve through find so a draft forks the new doc into this draft's clones.
	const chat = await repo.find(created.url)
	target.change((d: any) => {
		if (!d["@patchwork"]) d["@patchwork"] = {}
		d["@patchwork"].chitchat = chat.url
	})
	return chat as DocHandle<ChatDoc>
}

function ContextHost(props: {element: HTMLElement; repo: Repo}) {
	const targetUrl = selectedDocUrl(props.element)
	const [chatHandle, setChatHandle] = createSignal<DocHandle<ChatDoc> | null>(
		null
	)
	let ensuringFor: string | null = null

	// The account-scoped tool-storage doc that remembers the user's default
	// chitchat plugin set. Resolve its handle; ensure it has `defaultPlugins`.
	const storageUrl = toolStorageUrl(props.element, "chitchat")
	const [storageHandle, setStorageHandle] =
		createSignal<DocHandle<ToolStorageDoc> | null>(null)
	createEffect(() => {
		const url = storageUrl()
		if (!url) return
		props.repo
			.find(url)
			.then((h) => {
				const storage = h as DocHandle<ToolStorageDoc>
				if (!Array.isArray(storage.doc()?.defaultPlugins)) {
					storage.change((d) => {
						if (!Array.isArray(d.defaultPlugins))
							d.defaultPlugins = DEFAULT_CHITCHAT_PLUGINS.slice()
					})
				} else if (isOldDefaultChitchatPlugins(storage.doc()?.defaultPlugins)) {
					storage.change((d) => {
						if (isOldDefaultChitchatPlugins(d.defaultPlugins))
							d.defaultPlugins = DEFAULT_CHITCHAT_PLUGINS.slice()
					})
				}
				setStorageHandle(storage)
			})
			.catch((e) => console.warn("[chitchat] tool-storage:", e))
	})
	const defaultPlugins = () =>
		storageHandle()?.doc()?.defaultPlugins ?? DEFAULT_CHITCHAT_PLUGINS

	createEffect(() => {
		const url = targetUrl()
		if (!url) {
			ensuringFor = null
			setChatHandle(null)
			return
		}
		if (ensuringFor === url) return
		ensuringFor = url
		setChatHandle(null)
		ensureChitchat(props.repo, url, defaultPlugins())
			.then((h) => {
				// Ignore if the selection moved on while we were resolving.
				if (targetUrl() === url) setChatHandle(h)
			})
			.catch((e) => console.warn("[chitterchatter:context] ensureChitchat", e))
	})

	// Mirror last-used: when the active chitchat's plugin set changes, remember it
	// as the default for future chitchats.
	createEffect(() => {
		const chat = chatHandle()
		const storage = storageHandle()
		if (!chat || !storage) return
		const write = () => {
			const plugins = (chat.doc() as any)?.plugins
			if (!Array.isArray(plugins)) return
			const current = storage.doc()?.defaultPlugins
			if (
				Array.isArray(current) &&
				current.length === plugins.length &&
				current.every((p, i) => p === plugins[i])
			)
				return
			storage.change((d) => {
				d.defaultPlugins = plugins.slice()
			})
		}
		write()
		chat.on("change", write)
		onCleanup(() => chat.off("change", write))
	})

	return (
		<Show
			when={chatHandle()}
			keyed
			fallback={
				<div class="chat-context-empty">
					{targetUrl()
						? "Loading chat…"
						: "Select a document to chat about it."}
				</div>
			}>
			{(handle) => (
				<ChatRoot
					handle={handle}
					element={props.element}
					mode="context"
					targetDocUrl={targetUrl}
				/>
			)}
		</Show>
	)
}

/** patchwork:component render: `(element) => cleanup`. */
export function ChatContextComponent(element: HTMLElement) {
	const repo: Repo = (element as any).repo || (window as any).repo
	setRepo(repo)

	if (getComputedStyle(element).position === "static") {
		element.style.position = "relative"
	}

	const dispose = render(
		() => <ContextHost element={element} repo={repo} />,
		element
	)
	return () => dispose()
}
