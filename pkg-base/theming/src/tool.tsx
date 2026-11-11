import {render} from "solid-js/web"
import {createEffect, createMemo, createSignal, For, Show} from "solid-js"
import {getRegistry} from "@inkandswitch/patchwork-plugins"
import {
	detectColorScheme,
	getActiveThemeState,
	onActiveThemeChange,
	setThemeForMode,
	startActiveTheme,
} from "./active-theme.ts"

type ThemeDescription = {
	id: string
	name?: string
	style?: string
	colorScheme?: "light" | "dark"
}

type Mode = "light" | "dark"

export function ThemePickerTool(handle: any, element: HTMLElement) {
	startActiveTheme(element, handle)

	const [themeState, setThemeState] = createSignal(getActiveThemeState())
	const unsubscribeThemeState = onActiveThemeChange(setThemeState)

	const [themes, setThemes] = createSignal<ThemeDescription[]>([])
	const [colorSchemes, setColorSchemes] = createSignal<
		Record<string, "light" | "dark" | undefined>
	>({})
	// Whether the light/dark themes are edited separately. Defaults to whether the
	// two saved themes already differ; the "same theme in both" checkbox flips it.
	const [splitModes, setSplitModes] = createSignal(
		getActiveThemeState().light !== getActiveThemeState().dark
	)

	async function detectAll(themeList: ThemeDescription[]) {
		const schemes: Record<string, "light" | "dark" | undefined> = {}
		await Promise.all(
			themeList.map(async (t) => {
				schemes[t.id] = await detectColorScheme(t)
			})
		)
		setColorSchemes(schemes)
	}

	// Discover available themes from registry
	const themeRegistry = getRegistry("patchwork:theme")
	const refresh = () => {
		const all = (themeRegistry.all?.() || []) as ThemeDescription[]
		setThemes(all)
		detectAll(all)
	}
	refresh()
	themeRegistry.on("registered", refresh)
	themeRegistry.on("removed", refresh)

	const themeLabel = (theme: ThemeDescription) => theme.name || theme.id
	const nameFor = (id: string) => {
		const theme = themes().find((t) => t.id === id)
		return theme ? themeLabel(theme) : id
	}

	const sortedThemes = createMemo(() =>
		[...themes()].sort((a, b) =>
			themeLabel(a).localeCompare(themeLabel(b), undefined, {sensitivity: "base"})
		)
	)

	// Themes grouped for a target mode: the matching scheme (plus scheme-agnostic
	// themes) first, the opposite scheme second.
	const groupsFor = (mode: Mode) => {
		const schemes = colorSchemes()
		const belongs = (id: string) =>
			mode === "light" ? schemes[id] !== "dark" : schemes[id] !== "light"
		return {
			primary: sortedThemes().filter((t) => belongs(t.id)),
			secondary: sortedThemes().filter((t) => !belongs(t.id)),
		}
	}

	const style = document.createElement("style")
	style.textContent = `
		.theme-picker {
			padding: var(--studio-space-lg, 1.5rem);
			font-family: var(--studio-family-sans, system-ui, sans-serif);
			color: var(--studio-line, black);
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-lg, 1.5rem);
			max-width: 44rem;
		}
		.theme-picker-head {
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-2xs, 0.25rem);
		}
		.theme-picker-heading {
			font-size: 1.25rem;
			font-weight: 700;
			margin: 0;
		}
		.theme-picker-status {
			margin: 0;
			font-size: 0.9rem;
			line-height: 1.4;
			color: color-mix(in oklch, var(--studio-line, black), transparent 30%);
		}
		.theme-picker-status b {
			font-weight: 600;
			color: var(--studio-line, black);
		}
		.theme-picker-toggle {
			display: inline-flex;
			align-items: center;
			gap: var(--studio-space-2xs, 0.375rem);
			align-self: flex-start;
			font-size: 0.85rem;
			cursor: var(--studio-cursor-pointer, pointer);
			user-select: none;
		}
		.theme-picker-toggle input {
			margin: 0;
			width: 0.95rem;
			height: 0.95rem;
			accent-color: var(--studio-primary, #35f7ca);
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-picker-section {
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-sm, 0.5rem);
		}
		.theme-picker-section-title {
			display: flex;
			align-items: baseline;
			gap: var(--studio-space-xs, 0.4rem);
			margin: 0;
			font-size: 0.8rem;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.05em);
			color: color-mix(in oklch, var(--studio-line, black), transparent 45%);
		}
		.theme-picker-now {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			padding: 0.1rem 0.4rem;
			border-radius: 999px;
			font-size: 0.62rem;
			font-weight: 700;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.03em);
			text-transform: none;
			color: var(--studio-fill, white);
			background: var(--studio-primary, #0a7);
		}
		.theme-picker-group-caption {
			margin: var(--studio-space-2xs, 0.25rem) 0 0;
			font-size: 0.68rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.05em);
			color: color-mix(in oklch, var(--studio-line, black), transparent 55%);
		}
		.theme-picker-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
			gap: var(--studio-space-sm, 0.6rem);
		}
		.theme-picker-card {
			position: relative;
			padding: 0;
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 82%);
			border-radius: var(--studio-radius-md, 8px);
			background: none;
			cursor: var(--studio-cursor-pointer, pointer);
			overflow: hidden;
			transition: box-shadow var(--studio-transition-fast, 0.1s ease), border-color var(--studio-transition-fast, 0.1s ease);
		}
		.theme-picker-card:hover {
			border-color: color-mix(in oklch, var(--studio-line, black), transparent 55%);
		}
		.theme-picker-card[data-selected] {
			border-color: transparent;
			box-shadow: 0 0 0 2px var(--studio-line, black);
		}
		.theme-picker-preview {
			display: flex;
			flex-direction: column;
			justify-content: space-between;
			gap: var(--studio-space-sm, 0.5rem);
			min-height: 4.75rem;
			padding: var(--studio-space-sm, 0.6rem);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			text-align: left;
		}
		.theme-picker-preview-name {
			font-size: 0.85rem;
			font-weight: 600;
			line-height: 1.1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.theme-picker-dots {
			display: flex;
			gap: 0.3rem;
		}
		.theme-picker-dot {
			width: 0.85rem;
			height: 0.85rem;
			border-radius: 999px;
			box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--studio-line, black), transparent 65%);
		}
		.theme-picker-dot--fill { background: var(--studio-fill, #fff); }
		.theme-picker-dot--primary { background: var(--studio-primary, #35f7ca); }
		.theme-picker-dot--secondary { background: var(--studio-secondary, #ec6ca7); }
		.theme-picker-check {
			position: absolute;
			top: 0.35rem;
			right: 0.35rem;
			width: 1.15rem;
			height: 1.15rem;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 999px;
			font-size: 0.7rem;
			color: var(--studio-fill, white);
			background: var(--studio-line, black);
		}
		.theme-picker-empty {
			padding: var(--studio-space-md, 1rem);
			color: color-mix(in oklch, var(--studio-line, black), transparent 45%);
			font-size: 0.9rem;
		}
	`
	element.appendChild(style)

	const dispose = render(() => {
		const currentMode = () => themeState().mode
		const activeThemeId = () => themeState().themeId
		const showTwoSections = () => splitModes()

		function choose(mode: Mode | "both", id: string) {
			if (mode === "both") {
				setThemeForMode("light", id)
				setThemeForMode("dark", id)
			} else {
				setThemeForMode(mode, id)
			}
		}

		function setSameForBoth(same: boolean) {
			if (same) {
				choose("both", themeState().themeId)
				setSplitModes(false)
			} else {
				setSplitModes(true)
			}
		}

		// A theme card that previews the theme's own palette. The outer button
		// stays in the host chrome context (so its border/selected ring are
		// visible against any preview), while the inner surface adopts the theme.
		function Card(props: {
			theme: ThemeDescription
			selected: boolean
			onChoose: () => void
		}) {
			return (
				<button
					class="theme-picker-card"
					data-selected={props.selected ? "" : undefined}
					title={themeLabel(props.theme)}
					onClick={props.onChoose}
				>
					<div class="theme-picker-preview" theme={props.theme.id}>
						<span class="theme-picker-preview-name">
							{themeLabel(props.theme)}
						</span>
						<div class="theme-picker-dots">
							<span class="theme-picker-dot theme-picker-dot--primary" />
							<span class="theme-picker-dot theme-picker-dot--secondary" />
							<span class="theme-picker-dot theme-picker-dot--fill" />
						</div>
					</div>
					<Show when={props.selected}>
						<span class="theme-picker-check">✓</span>
					</Show>
				</button>
			)
		}

		// One labelled section for a mode (or the shared "both" case). Lists the
		// matching-scheme themes first, then the opposite scheme under a caption.
		function Section(props: {
			mode: Mode | "both"
			groupMode: Mode
			label: string
			selectedId: string
		}) {
			const groups = () => groupsFor(props.groupMode)
			const primaryCaption = () =>
				props.groupMode === "light" ? "Light themes" : "Dark themes"
			const secondaryCaption = () =>
				props.groupMode === "light" ? "Dark themes" : "Light themes"
			const isNow = () =>
				props.mode !== "both" && currentMode() === props.mode

			return (
				<section class="theme-picker-section">
					<h3 class="theme-picker-section-title">
						<span>{props.label}</span>
						<Show when={isNow()}>
							<span class="theme-picker-now">showing now</span>
						</Show>
					</h3>
					<Show when={groups().secondary.length > 0}>
						<p class="theme-picker-group-caption">{primaryCaption()}</p>
					</Show>
					<div class="theme-picker-grid">
						<For each={groups().primary}>
							{(theme) => (
								<Card
									theme={theme}
									selected={props.selectedId === theme.id}
									onChoose={() => choose(props.mode, theme.id)}
								/>
							)}
						</For>
					</div>
					<Show when={groups().secondary.length > 0}>
						<p class="theme-picker-group-caption">{secondaryCaption()}</p>
						<div class="theme-picker-grid">
							<For each={groups().secondary}>
								{(theme) => (
									<Card
										theme={theme}
										selected={props.selectedId === theme.id}
										onChoose={() => choose(props.mode, theme.id)}
									/>
								)}
							</For>
						</div>
					</Show>
				</section>
			)
		}

		return (
			<div class="theme-picker">
				<div class="theme-picker-head">
					<h2 class="theme-picker-heading">Theme</h2>
					<p class="theme-picker-status">
						Your system is in <b>{currentMode()} mode</b> right now, so{" "}
						<b>{nameFor(activeThemeId())}</b> is showing.
					</p>
				</div>

				<label class="theme-picker-toggle">
					<input
						type="checkbox"
						checked={!showTwoSections()}
						onChange={(event) => setSameForBoth(event.currentTarget.checked)}
					/>
					Use the same theme in both light and dark mode
				</label>

				<Show when={themes().length === 0}>
					<div class="theme-picker-empty">No themes are available yet.</div>
				</Show>

				<Show
					when={showTwoSections()}
					fallback={
						<Section
							mode="both"
							groupMode={currentMode()}
							label="Theme"
							selectedId={activeThemeId()}
						/>
					}
				>
					<Section
						mode="light"
						groupMode="light"
						label="Light mode theme"
						selectedId={themeState().light}
					/>
					<Section
						mode="dark"
						groupMode="dark"
						label="Dark mode theme"
						selectedId={themeState().dark}
					/>
				</Show>
			</div>
		)
	}, element)

	return () => {
		unsubscribeThemeState()
		themeRegistry.off?.("registered", refresh)
		themeRegistry.off?.("removed", refresh)
		dispose()
		style.remove()
	}
}
