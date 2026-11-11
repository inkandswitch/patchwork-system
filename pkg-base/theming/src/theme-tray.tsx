import {createEffect, createMemo, createSignal, For, onCleanup, Show} from "solid-js"
import {Portal, render} from "solid-js/web"
import {getRegistry} from "@inkandswitch/patchwork-plugins"
import {
	getActiveThemeState,
	hasThemePreferences,
	onActiveThemeChange,
	serveCurrentThemeProvider,
	setThemeForCurrentMode,
	startActiveTheme,
} from "./active-theme.ts"

type ThemeDescription = {
	id: string
	name?: string
	style?: string
	colorScheme?: "light" | "dark"
}

export function ThemeTray(element: HTMLElement) {
	startActiveTheme(element)

	// Serve the active theme to isolated tools (e.g. the titlebar theme tool)
	// over the `patchwork:current-theme` provider. Installed on <html> so that
	// bridged subscribe events, which bubble up to the document root, reach it.
	const stopThemeProvider = serveCurrentThemeProvider(document.documentElement)

	const style = document.createElement("style")
	style.textContent = `
		.theme-tray {
			position: relative;
			display: inline-flex;
			align-items: center;
		}
		.theme-tray-button {
			display: inline-flex;
			align-items: center;
			gap: var(--studio-space-2xs, 0.25rem);
			min-width: 0;
			height: 1.75rem;
			padding: 0 var(--studio-space-xs, 0.375rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--studio-chrome-offset-20, var(--studio-fill-offset-20, #d4d4d4));
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-chrome, var(--studio-fill, white));
			color: var(--studio-chrome-line, var(--studio-line, black));
			font: 500 0.75rem/1 var(--studio-family-sans, system-ui, sans-serif);
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-tray-button:hover {
			background: var(--studio-chrome-hover-fill, var(--studio-chrome-offset-10, var(--studio-fill-offset-10, #f2f2f2)));
		}
		.theme-tray-swatch {
			width: 0.75rem;
			height: 0.75rem;
			border-radius: var(--studio-radius-xs, 2px);
			background: linear-gradient(135deg, var(--studio-primary-fill, var(--studio-primary, #35f7ca)) 0 50%, var(--studio-secondary-fill, var(--studio-secondary, #ec6ca7)) 50% 100%);
			box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--studio-line, black), transparent 75%);
			flex: none;
		}
		.theme-tray-label {
			max-width: 9rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.theme-tray-popover {
			position: fixed;
			z-index: var(--studio-layer-popover, 1000);
			width: 13rem;
			max-height: min(18rem, 60vh);
			overflow-y: auto;
			padding: var(--studio-space-2xs, 0.25rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--studio-chrome-offset-20, var(--studio-fill-offset-20, #d4d4d4));
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-chrome, var(--studio-fill, white));
			color: var(--studio-chrome-line, var(--studio-line, black));
			box-shadow: 0 0.5rem 1rem color-mix(in oklch, var(--studio-line, black), transparent 88%);
			font-family: var(--studio-family-sans, system-ui, sans-serif);
			/* Grows out of the tray button once it has been measured and placed
			   (data-placed). Closing is instant. */
			opacity: 0;
			scale: 0.97;
			transform-origin: top right;
		}
		.theme-tray-popover[data-side="above"] {
			transform-origin: bottom right;
		}
		.theme-tray-popover[data-placed] {
			opacity: 1;
			scale: 1;
			transition:
				opacity max(1ms, calc(150ms * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))) var(--studio-ease-out, cubic-bezier(0.23, 1, 0.32, 1)),
				scale max(1ms, calc(150ms * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))) var(--studio-ease-out, cubic-bezier(0.23, 1, 0.32, 1));
		}
		.theme-tray-header {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: var(--studio-space-sm, 0.5rem);
			padding: var(--studio-space-2xs, 0.25rem) var(--studio-space-xs, 0.375rem);
		}
		.theme-tray-title {
			font: 600 0.72rem/1 var(--studio-family-sans, system-ui, sans-serif);
			text-transform: lowercase;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.02em);
			opacity: 0.7;
		}
		.theme-tray-toggle {
			display: inline-flex;
			align-items: center;
			gap: var(--studio-space-2xs, 0.25rem);
			font: 500 0.68rem/1 var(--studio-family-sans, system-ui, sans-serif);
			opacity: 0.7;
			cursor: var(--studio-cursor-pointer, pointer);
			user-select: none;
		}
		.theme-tray-toggle input {
			margin: 0;
			accent-color: var(--studio-primary-fill, var(--studio-primary, #35f7ca));
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-tray-filter {
			width: 100%;
			height: 1.75rem;
			margin-bottom: var(--studio-space-2xs, 0.25rem);
			padding: 0 var(--studio-space-xs, 0.375rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--studio-chrome-offset-20, var(--studio-fill-offset-20, #d4d4d4));
			border-radius: var(--studio-radius-xs, 2px);
			background: var(--studio-chrome-fill, var(--studio-fill, white));
			color: var(--studio-chrome-line, var(--studio-line, black));
			font: 500 0.78rem/1 var(--studio-family-sans, system-ui, sans-serif);
			box-sizing: border-box;
		}
		.theme-tray-empty {
			padding: var(--studio-space-xs, 0.375rem);
			color: color-mix(in oklch, var(--studio-chrome-line, var(--studio-line, black)), transparent 40%);
			font: 500 0.78rem/1 var(--studio-family-sans, system-ui, sans-serif);
			text-align: center;
		}
		.theme-tray-option {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: var(--studio-space-sm, 0.5rem);
			width: 100%;
			min-height: 1.75rem;
			padding: 0 var(--studio-space-xs, 0.375rem);
			border: 0;
			border-radius: var(--studio-radius-xs, 2px);
			background: var(--studio-chrome-fill, var(--studio-fill, white));
			color: var(--studio-chrome-line, var(--studio-line, black));
			font: 500 0.78rem/1 var(--studio-family-sans, system-ui, sans-serif);
			text-align: left;
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-tray-option:hover {
			background: var(--studio-chrome-hover-fill, var(--studio-chrome-fill-offset-20, var(--studio-fill-offset-20, #f2f2f2)));
		}
		.theme-tray-option[data-selected] {
			box-shadow: inset 0 0 0 1px var(--studio-chrome-line, var(--studio-line, black));
		}
		.theme-tray-option-name {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.theme-tray-option-check {
			flex: none;
			font-size: 0.72rem;
		}
	`
	element.appendChild(style)

	const dispose = render(() => {
		const [state, setState] = createSignal(getActiveThemeState())
		const [open, setOpen] = createSignal(false)
		const [popoverPosition, setPopoverPosition] = createSignal<{
			left: number
			top: number
			above: boolean
		}>()
		const [themes, setThemes] = createSignal<ThemeDescription[]>([])
		const [filter, setFilter] = createSignal("")
		const showNameKey = "patchwork:theme-tray:show-name"
		const [showName, setShowName] = createSignal(
			localStorage.getItem(showNameKey) === "true"
		)
		createEffect(() =>
			localStorage.setItem(showNameKey, showName() ? "true" : "false")
		)
		const themeRegistry = getRegistry("patchwork:theme") as any
		const unsubscribe = onActiveThemeChange(setState)
		let buttonElement: HTMLButtonElement | undefined
		let popoverElement: HTMLDivElement | undefined
		let filterElement: HTMLInputElement | undefined

		const themeLabel = (theme: ThemeDescription) => theme.name || theme.id

		const sortedThemes = createMemo(() =>
			[...themes()].sort((a, b) =>
				themeLabel(a).localeCompare(themeLabel(b), undefined, {sensitivity: "base"})
			)
		)

		const visibleThemes = createMemo(() => {
			const query = filter().trim().toLowerCase()
			if (!query) return sortedThemes()
			return sortedThemes().filter(
				(theme) =>
					themeLabel(theme).toLowerCase().includes(query) ||
					theme.id.toLowerCase().includes(query)
			)
		})

		const refreshThemes = () => setThemes(themeRegistry.all?.() || [])
		refreshThemes()
		themeRegistry.on("registered", refreshThemes)
		themeRegistry.on("removed", refreshThemes)

		const updatePopoverPosition = () => {
			if (!buttonElement || !popoverElement) return

			const gap = 4
			const margin = 8
			const buttonRect = buttonElement.getBoundingClientRect()
			const popoverRect = popoverElement.getBoundingClientRect()
			const maxLeft = Math.max(margin, window.innerWidth - popoverRect.width - margin)
			const maxTop = Math.max(margin, window.innerHeight - popoverRect.height - margin)
			const left = Math.min(Math.max(buttonRect.right - popoverRect.width, margin), maxLeft)
			const preferredTop =
				buttonRect.top >= popoverRect.height + margin + gap
					? buttonRect.top - popoverRect.height - gap
					: buttonRect.bottom + gap
			const top = Math.min(Math.max(preferredTop, margin), maxTop)

			setPopoverPosition({left, top, above: top < buttonRect.top})
		}

		const onDocumentClick = (event: MouseEvent) => {
			const target = event.target as Node
			if (!element.contains(target) && !popoverElement?.contains(target)) setOpen(false)
		}
		document.addEventListener("click", onDocumentClick)

		const onDocumentKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false)
		}
		document.addEventListener("keydown", onDocumentKeyDown)

		createEffect(() => {
			if (!open()) return

			const animationFrame = requestAnimationFrame(() => {
				updatePopoverPosition()
				filterElement?.focus()
			})
			window.addEventListener("resize", updatePopoverPosition)
			window.addEventListener("scroll", updatePopoverPosition, true)

			onCleanup(() => {
				cancelAnimationFrame(animationFrame)
				window.removeEventListener("resize", updatePopoverPosition)
				window.removeEventListener("scroll", updatePopoverPosition, true)
				setPopoverPosition(undefined)
				setFilter("")
			})
		})

		onCleanup(() => {
			unsubscribe()
			themeRegistry.off?.("registered", refreshThemes)
			themeRegistry.off?.("removed", refreshThemes)
			document.removeEventListener("click", onDocumentClick)
			document.removeEventListener("keydown", onDocumentKeyDown)
		})

		function chooseTheme(id: string) {
			if (!hasThemePreferences()) return
			setThemeForCurrentMode(id)
			setOpen(false)
		}

		const activeThemeId = () => state().themeId
		return (
			<div class="theme-tray">
				<button
					ref={buttonElement}
					class="theme-tray-button"
					title={`Theme: ${activeThemeId()}`}
					onClick={(event) => {
						event.stopPropagation()
						setOpen((value) => !value)
					}}
				>
					<span class="theme-tray-swatch" />
					<Show when={showName()}>
						<span class="theme-tray-label">{activeThemeId()}</span>
					</Show>
				</button>
				<Show when={open()}>
					<Portal mount={document.body}>
						<div
							ref={popoverElement}
							class="theme-tray-popover"
							data-placed={popoverPosition() ? "" : undefined}
							data-side={popoverPosition()?.above ? "above" : "below"}
							style={{
								left: `${popoverPosition()?.left ?? 0}px`,
								top: `${popoverPosition()?.top ?? 0}px`,
								visibility: popoverPosition() ? "visible" : "hidden",
							}}
							onClick={(event) => event.stopPropagation()}
						>
							<div class="theme-tray-header">
								<span class="theme-tray-title">theme</span>
								<label class="theme-tray-toggle">
									<input
										type="checkbox"
										checked={showName()}
										onChange={(event) =>
											setShowName(event.currentTarget.checked)
										}
									/>
									show name
								</label>
							</div>
							<input
								ref={filterElement}
								class="theme-tray-filter"
								type="text"
								placeholder="Filter themes…"
								value={filter()}
								onInput={(event) => setFilter(event.currentTarget.value)}
							/>
							<For each={visibleThemes()}>
								{(theme) => (
									<button
										class="theme-tray-option"
										theme={theme.id}
										data-selected={activeThemeId() === theme.id ? "" : undefined}
										title={theme.name || theme.id}
										onClick={() => chooseTheme(theme.id)}
									>
										<span class="theme-tray-option-name">
											{theme.name || theme.id}
										</span>
										<Show when={activeThemeId() === theme.id}>
											<span class="theme-tray-option-check">selected</span>
										</Show>
									</button>
								)}
							</For>
							<Show when={visibleThemes().length === 0}>
								<div class="theme-tray-empty">No matching themes</div>
							</Show>
						</div>
					</Portal>
				</Show>
			</div>
		)
	}, element)

	return () => {
		dispose()
		style.remove()
		stopThemeProvider()
	}
}
