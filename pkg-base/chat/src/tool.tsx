import {render} from "solid-js/web"
import {ChatRoot} from "./components/ChatRoot"
import type {DocHandle} from "@automerge/automerge-repo/slim"
import type {ChatDoc} from "./types"
import type {FeatureSelector} from "./features"
import {setRepo} from "./lib/repo"

// The chat tool render fn. There is ONE tool — which features are active is
// driven by the document's `plugins` array (seeded by the `chat` / `chitterchatter`
// datatypes, mutated live via `/plugin`), NOT by which tool you opened. So no
// selector is passed here: ChatRoot reads the doc.
export function ChatTool(handle: DocHandle<ChatDoc>, element: HTMLElement) {
	// The tool element carries the repo for this tool instance — use it instead
	// of the global window.repo.
	setRepo((element as any).repo)

	// Ensure the host element is a positioning context
	if (getComputedStyle(element).position === "static") {
		element.style.position = "relative"
	}

	const dispose = render(
		() => <ChatRoot handle={handle} element={element} />,
		element
	)

	return () => {
		dispose()
	}
}

// patchwork:component render — `(element) => cleanup`. Self-acquires the doc from
// the element's doc-url and renders ChatRoot, so the host can embed chat via
// <patchwork-view component="chat">. Selector from a `features` attr
// (default "core" — a lightweight embed).
export function ChatComponent(element: HTMLElement) {
	const repo = (element as any).repo || (window as any).repo
	setRepo(repo)
	const url =
		element.getAttribute("doc-url") || (element as any).docUrl || null
	// Optional selector OVERRIDE from a `features` attr: "all" | "core" |
	// comma-separated ids. No attr → doc-driven (follows the doc's `plugins`).
	const attr = element.getAttribute("features")
	const selector: FeatureSelector | undefined = !attr
		? undefined
		: attr === "all" || attr === "core"
			? attr
			: attr.split(",").map((s) => s.trim()).filter(Boolean)

	let dispose: (() => void) | null = null
	let disposed = false

	;(async () => {
		if (!repo || !url) return
		try {
			const handle = await repo.find(url.split("#")[0])
			if (disposed) return
			if (getComputedStyle(element).position === "static") {
				element.style.position = "relative"
			}
			dispose = render(
				() => <ChatRoot handle={handle} element={element} selector={selector} />,
				element
			)
		} catch (e) {
			console.warn("[Chat] component find:", e)
		}
	})()

	return () => {
		disposed = true
		dispose?.()
	}
}
