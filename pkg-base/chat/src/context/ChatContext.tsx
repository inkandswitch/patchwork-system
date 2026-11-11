import {createContext, useContext, createSignal, createMemo, createEffect, onCleanup, type ParentComponent, type Accessor, type Resource} from "solid-js"
import type {DocHandle, Repo, Doc} from "@automerge/automerge-repo/slim"
import type {ChatDoc} from "../types"
import type {FeatureSelector} from "../features"
import type {PluginSelector} from "../lib/registry"
import {expandSelector, docSelector} from "../lib/plugin-catalog"

interface ChatContextValue {
	handle: DocHandle<ChatDoc>
	doc: Accessor<Doc<ChatDoc> | undefined>
	repo: Repo
	element: HTMLElement
	chatUrl: string
	// The active plugin id set as a resolvePlugins() selector — derived reactively
	// from `doc.plugins` (or an explicit override), so the four consumers (parser /
	// slash / actions / emoji) re-resolve live when plugins are loaded/unloaded.
	selector: Accessor<PluginSelector>
	// Is a `chat:feature` (or any plugin) active for this doc?
	hasFeature: (id: string) => boolean
}

const ChatCtx = createContext<ChatContextValue>()

export const ChatProvider: ParentComponent<{
	handle: DocHandle<ChatDoc>
	element: HTMLElement
	// Optional selector OVERRIDE (embeddable component's `features=` attr). When
	// absent, the active set is driven by the document's `plugins` array.
	selector?: FeatureSelector
}> = (props) => {
	const repo = (props.element as any).repo as Repo

	// Manual doc signal — subscribes directly to handle changes.
	// This is more reliable than useDocument on reload since it doesn't
	// depend on the repo re-finding the handle.
	const [doc, setDoc] = createSignal<Doc<ChatDoc> | undefined>(props.handle.doc() as Doc<ChatDoc> | undefined)

	const onChange = () => {
		const d = props.handle.doc() as Doc<ChatDoc> | undefined
		if (d) setDoc(() => d)
	}

	// If doc wasn't ready synchronously, wait for it
	if (!doc()) {
		repo.find(props.handle.url).then((h: DocHandle<ChatDoc>) => {
			const d = h.doc() as Doc<ChatDoc> | undefined
			if (d) setDoc(() => d)
		}).catch(() => {})
	}

	props.handle.on("change", onChange)
	onCleanup(() => props.handle.off("change", onChange))

	// Active id set: the override wins, else the doc's `plugins` array. Reactive
	// over the doc so `/plugin load` lights up UI without a reload.
	const activeIds = createMemo(() =>
		expandSelector(props.selector ?? docSelector(doc()))
	)
	const selector: Accessor<PluginSelector> = () => [...activeIds()]
	const hasFeature = (id: string) => activeIds().has(id)

	return (
		<ChatCtx.Provider
			value={{
				handle: props.handle,
				doc,
				repo,
				element: props.element,
				chatUrl: props.handle.url,
				selector,
				hasFeature,
			}}
		>
			{props.children}
		</ChatCtx.Provider>
	)
}

export function useChat(): ChatContextValue {
	const ctx = useContext(ChatCtx)
	if (!ctx) throw new Error("useChat must be used within ChatProvider")
	return ctx
}
