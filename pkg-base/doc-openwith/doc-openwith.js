import {render} from "solid-js/web"
import html from "solid-js/html"
import {createSignal} from "solid-js"
import {getType} from "@inkandswitch/patchwork-filesystem"
import {getRegistry} from "@inkandswitch/patchwork-plugins"

function DocOpenWith(handle, element) {
	const [tools, setTools] = createSignal([])
	const [open, setOpen] = createSignal(false)

	function refresh() {
		const doc = handle.doc()
		if (!doc) return setTools([])
		const type = getType(doc)
		const list = getRegistry("patchwork:tool").filter(t => {
			const sd = t.supportedDatatypes
			const matches =
				sd === "*" ||
				(Array.isArray(sd) &&
					(sd.includes("*") || (type && sd.includes(type))))
			return matches && !t.unlisted && !t.forTitleBar
		})
		list.sort((a, b) => {
			const aWild =
				a.supportedDatatypes === "*" ||
				(Array.isArray(a.supportedDatatypes) &&
					a.supportedDatatypes.includes("*"))
			const bWild =
				b.supportedDatatypes === "*" ||
				(Array.isArray(b.supportedDatatypes) &&
					b.supportedDatatypes.includes("*"))
			return aWild - bWild
		})
		setTools(list)
	}

	refresh()
	handle.on("change", refresh)
	const off = getRegistry("patchwork:tool").on("changed", refresh)

	const doc = handle.doc()
	if (doc) {
		const datatypeId = getType(doc)
		if (datatypeId) {
			getRegistry("patchwork:datatype")
				.load(datatypeId)
				.then(() => refresh())
		}
	}

	function pickTool(toolId) {
		menuEl.hidePopover()
		element.dispatchEvent(
			new CustomEvent("patchwork:open-document", {
				detail: {url: handle.url, toolId},
				bubbles: true,
				composed: true,
			}),
		)
	}

	const style = document.createElement("style")
	style.textContent = `
		@layer package {
		:root,
		:host,
		[theme] {
			--doc-openwith-bg: var(--studio-fill, white);
			--doc-openwith-fg: var(--studio-line, black);
			--doc-openwith-border: var(--studio-fill-offset-20, #ccc);
			--doc-openwith-border-hover: var(--studio-fill-offset-30, #aaa);
			--doc-openwith-hover: var(--studio-fill-offset-10, #f4f4f4);
			--doc-openwith-divider: var(--studio-fill-offset-10, #eee);
			--doc-openwith-highlight: var(--studio-fill-offset-10, #f0f0f0);
		}
		}

		.doc-openwith {
			display: flex;
			align-items: center;
			height: 100%;
		}

		.doc-openwith-btn {
			display: flex;
			align-items: center;
			height: 22px;
			padding: 0 var(--studio-space-sm, 0.5rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--doc-openwith-border);
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--doc-openwith-bg);
			color: var(--doc-openwith-fg);
			font: inherit;
			font-size: 0.8em;
			font-weight: 500;
			cursor: var(--studio-cursor-pointer, pointer);
			transition: border-color var(--studio-transition-fast, 0.1s ease),
				background var(--studio-transition-fast, 0.1s ease);
			white-space: nowrap;
			user-select: none;
		}

		.doc-openwith-btn:hover,
		.doc-openwith-btn[data-open] {
			border-color: var(--doc-openwith-border-hover);
			background: var(--doc-openwith-hover);
		}

		.doc-openwith-menu[popover] {
			position: fixed;
			inset: unset;
			margin: 0;
			padding: 0;
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--doc-openwith-border);
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--doc-openwith-bg);
			box-shadow: var(--studio-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
			overflow: hidden;
		}

		.doc-openwith-input {
			display: block;
			width: 100%;
			padding: var(--studio-space-xs, 0.375rem) var(--studio-space-sm, 0.5rem);
			border: none;
			border-bottom: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--doc-openwith-divider);
			background: none;
			font: inherit;
			font-size: 0.8em;
			color: inherit;
			outline: none;
			box-sizing: border-box;
		}

		.doc-openwith-list {
			max-height: 200px;
			overflow-y: auto;
			padding: var(--studio-space-2xs, 0.25rem);
		}

		.doc-openwith-item {
			display: block;
			width: 100%;
			padding: var(--studio-space-2xs, 0.25rem) var(--studio-space-sm, 0.5rem);
			border: none;
			border-radius: var(--studio-radius-xs, 2px);
			background: none;
			color: inherit;
			font: inherit;
			font-size: 0.8em;
			text-align: left;
			cursor: var(--studio-cursor-pointer, pointer);
			white-space: nowrap;
		}

		.doc-openwith-item:hover,
		.doc-openwith-item[data-highlight] {
			background: var(--doc-openwith-highlight);
		}
	`
	element.appendChild(style)

	// Popover menu with search input
	const menuEl = document.createElement("div")
	menuEl.popover = "auto"
	menuEl.className = "doc-openwith-menu"
	element.appendChild(menuEl)

	menuEl.addEventListener("toggle", e => setOpen(e.newState === "open"))

	function buildMenu() {
		menuEl.replaceChildren()

		const input = document.createElement("input")
		input.className = "doc-openwith-input"
		input.placeholder = "Search or enter tool id\u2026"
		menuEl.appendChild(input)

		const list = document.createElement("div")
		list.className = "doc-openwith-list"
		menuEl.appendChild(list)

		let highlighted = 0
		let filtered = []

		function highlightAt(i) {
			highlighted = i
			for (const [j, el] of [...list.children].entries()) {
				el.toggleAttribute("data-highlight", j === i)
			}
		}

		function renderList() {
			const q = input.value.toLowerCase()
			filtered = tools().filter(
				t =>
					!q ||
					t.name.toLowerCase().includes(q) ||
					t.id.toLowerCase().includes(q),
			)
			list.replaceChildren()
			filtered.forEach((t, i) => {
				const item = document.createElement("button")
				item.className = "doc-openwith-item"
				if (i === highlighted)
					item.toggleAttribute("data-highlight", true)
				item.textContent = t.name
				item.addEventListener("click", () => pickTool(t.id))
				item.addEventListener("pointerenter", () => highlightAt(i))
				list.appendChild(item)
			})
		}

		input.addEventListener("input", () => {
			highlighted = 0
			renderList()
		})

		input.addEventListener("keydown", e => {
			if (e.key === "ArrowDown") {
				e.preventDefault()
				highlightAt(Math.min(highlighted + 1, filtered.length - 1))
				list.children[highlighted]?.scrollIntoView({block: "nearest"})
			} else if (e.key === "ArrowUp") {
				e.preventDefault()
				highlightAt(Math.max(highlighted - 1, 0))
				list.children[highlighted]?.scrollIntoView({block: "nearest"})
			} else if (e.key === "Enter") {
				e.preventDefault()
				const q = input.value.trim()
				if (highlighted >= 0 && highlighted < filtered.length) {
					pickTool(filtered[highlighted].id)
				} else if (q) {
					pickTool(q)
				}
			} else if (e.key === "Escape") {
				menuEl.hidePopover()
			}
		})

		renderList()
		queueMicrotask(() => input.focus())
	}

	function toggleMenu() {
		const btn = element.querySelector(".doc-openwith-btn")
		if (!btn) return
		if (!open()) buildMenu()
		const rect = btn.getBoundingClientRect()
		const menuWidth = Math.max(rect.width, 180)
		menuEl.style.top = rect.bottom + 2 + "px"
		menuEl.style.minWidth = menuWidth + "px"
		// align left unless it would overflow the viewport, then align right
		if (rect.left + menuWidth > window.innerWidth - 8) {
			menuEl.style.left = ""
			menuEl.style.right = window.innerWidth - rect.right + "px"
		} else {
			menuEl.style.right = ""
			menuEl.style.left = rect.left + "px"
		}
		menuEl.togglePopover()
	}

	const dispose = render(
		() =>
			html`<div class="doc-openwith">
				${() => {
					if (!tools().length) return null
					return html`<button
						class=${() => `doc-openwith-btn${open() ? " doc-openwith-btn--open" : ""}`}
						onClick=${toggleMenu}
					>
						Open with\u2026
					</button>`
				}}
			</div>`,
		element,
	)

	return () => {
		handle.off("change", refresh)
		off()
		menuEl.remove()
		style.remove()
		dispose()
	}
}

export const plugins = [
	{
		type: "patchwork:tool",
		id: "doc-openwith",
		tags: ["titlebar-tool"],
		name: "Open With",
		icon: "ArrowRightLeft",
		supportedDatatypes: "*",
		forTitleBar: true,
		unlisted: true,
		async load() {
			return DocOpenWith
		},
	},
]
