// Minimal vanilla port of `@inkandswitch/patchwork-providers`'s `subscribe`,
// wrapped as a Solid accessor — so we don't have to add the providers-solid
// dependency (it isn't in the bootloader importmap and would be bundled anyway).
//
// It dispatches a `patchwork:subscribe` CustomEvent (from the nearest
// <patchwork-view>) carrying a MessagePort; the host's SelectedDocProvider
// answers by posting `{type:"change", value}` messages back over the port.
import {createSignal, createEffect, onCleanup, type Accessor} from "solid-js"
import type {AutomergeUrl, Repo, DocHandle} from "@automerge/automerge-repo/slim"

export type Selector = {type: string} & Record<string, unknown>

/** Subscribe to a provider selector; returns its latest value (or initial). */
export function subscribe<T>(
	element: HTMLElement,
	selector: Selector,
	initialValue: T
): Accessor<T> {
	const [value, setValue] = createSignal<T>(initialValue)

	const view = element.closest("patchwork-view")
	const dispatchEl = (view as HTMLElement) ?? element
	const channel = new MessageChannel()
	const port = channel.port2
	const controller = new AbortController()

	port.addEventListener(
		"message",
		(event: MessageEvent) => {
			if ((event.data as any)?.type === "change") {
				setValue(() => (event.data as any).value as T)
			}
		},
		{signal: controller.signal}
	)
	port.start()

	dispatchEl.dispatchEvent(
		new CustomEvent("patchwork:subscribe", {
			detail: {selector, port: channel.port1},
			bubbles: true,
			composed: true,
		})
	)

	onCleanup(() => {
		if (controller.signal.aborted) return
		controller.abort()
		try {
			port.postMessage({type: "unsubscribe"})
		} catch {}
		try {
			port.close()
		} catch {}
	})

	return value
}

/** The url of the document the user currently has selected (or undefined). */
export function selectedDocUrl(element: HTMLElement): Accessor<AutomergeUrl | undefined> {
	const urls = subscribe<AutomergeUrl[]>(
		element,
		{type: "patchwork:selected-doc"},
		[]
	)
	return () => urls()?.[0]
}

/** The text the user currently has selected in the focused editor. */
export type FocusSelection = {
	/** Cursor-anchored ref url of the range (stable across edits) — this is what
	 * gets attached to a message so the computer can resolve it later. */
	url: AutomergeUrl
	from: number
	to: number
	text: string
}

/** Read the range positions off a resolved ref, tolerating both the getter and
 * the method form across automerge-repo versions. */
function readRangePositions(ref: any): [number, number] | undefined {
	const rp = ref?.rangePositions
	return typeof rp === "function" ? ref.rangePositions() : rp
}

/** The live text selection inside the currently-focused document, resolved from
 * the shared `patchwork:focus` doc. The editor publishes its selection there as a
 * cursor-anchored ref url (`handle.sub("content", cursor(from,to)).url`); we
 * resolve that back to `[from,to]` and slice the focused doc's `content`.
 *
 * Returns null when nothing of the focused doc is selected, the selection is
 * empty (collapsed cursor), or it no longer resolves. */
export function focusSelection(
	element: HTMLElement,
	repo: Repo,
	targetUrl: Accessor<AutomergeUrl | undefined>
): Accessor<FocusSelection | null> {
	const focusDocUrl = subscribe<AutomergeUrl | undefined>(
		element,
		{type: "patchwork:focus"},
		undefined
	)
	const [result, setResult] = createSignal<FocusSelection | null>(null)
	// Resolving a ref url is async; cache so change-driven recomputes are sync.
	const refCache = new Map<string, any>()

	createEffect(() => {
		const furl = focusDocUrl()
		const turl = targetUrl()
		if (!furl || !turl) {
			setResult(null)
			return
		}
		let focusHandle: DocHandle<any> | null = null
		let targetHandle: DocHandle<any> | null = null
		let disposed = false

		const recompute = async () => {
			if (disposed) return
			const fdoc = focusHandle?.doc() as any
			const keys: string[] = fdoc?.selection ? Object.keys(fdoc.selection) : []
			// Only ranges anchored into the doc we're chatting about.
			const url = keys.find((k) => k.startsWith(turl)) as
				| AutomergeUrl
				| undefined
			if (!url) return setResult(null)
			try {
				let ref = refCache.get(url)
				if (!ref) {
					ref = await repo.find(url)
					refCache.set(url, ref)
				}
				if (disposed) return
				const pos = readRangePositions(ref)
				if (!pos || pos[0] === pos[1]) return setResult(null)
				const [from, to] = pos
				const content = (targetHandle?.doc() as any)?.content
				const text = typeof content === "string" ? content.slice(from, to) : ""
				setResult({url, from, to, text})
			} catch {
				setResult(null)
			}
		}

		Promise.all([repo.find(furl), repo.find(turl)])
			.then(([fh, th]) => {
				if (disposed) return
				focusHandle = fh
				targetHandle = th
				// Recompute on selection changes AND on target edits (positions shift).
				fh.on("change", recompute)
				th.on("change", recompute)
				recompute()
			})
			.catch(() => setResult(null))

		onCleanup(() => {
			disposed = true
			focusHandle?.off("change", recompute)
			targetHandle?.off("change", recompute)
		})
	})

	return result
}

/** The url of this tool's private, account-scoped storage doc (lazily created by
 * the host's `patchwork:tool-storage` provider on first request). */
export function toolStorageUrl(
	element: HTMLElement,
	toolId: string
): Accessor<AutomergeUrl | undefined> {
	return subscribe<AutomergeUrl | undefined>(
		element,
		{type: "patchwork:tool-storage", toolId},
		undefined
	)
}
