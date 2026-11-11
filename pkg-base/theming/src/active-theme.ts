import {getRegistry} from "@inkandswitch/patchwork-plugins"
import themeCssUrl from "./theme.css"
import lycheeCssUrl from "./lychee.css"
import gloomCssUrl from "./gloom.css"

type ActiveThemeState = {
	mode: "light" | "dark"
	themeId: string
	light: string
	dark: string
	preferencesUrl?: string
}

type ThemePreferencesHandle = {
	url?: string
	doc(): any
	change(fn: (doc: any) => void): void
	on?(event: "change", listener: () => void): void
	off?(event: "change", listener: () => void): void
}

export const CURRENT_THEME_SELECTOR = "patchwork:current-theme"

/**
 * Which themes an account that has not chosen one starts on. A site states
 * this on its root element — `<html data-theme-light="warm" data-theme-dark="dark">`
 * — so the answer comes from the site itself rather than from whichever
 * module happened to load last. `lychee`/`gloom` apply when it says nothing.
 *
 * Nothing is written to the preferences document: an unset preference resolves
 * through here at read time, so the theme a user picked explicitly is never
 * overwritten, and a site changing its defaults moves everyone who never
 * picked one.
 */
const FALLBACK_DEFAULTS = {light: "lychee", dark: "gloom"}

function defaultThemeIds() {
	const root = document.documentElement
	return {
		light: root.getAttribute("data-theme-light") || FALLBACK_DEFAULTS.light,
		dark: root.getAttribute("data-theme-dark") || FALLBACK_DEFAULTS.dark,
	}
}

const bundledStyleUrls = [themeCssUrl, lycheeCssUrl, gloomCssUrl].map(
	(href) => new URL(href, import.meta.url).href
)
const bundledStyles = new Set(bundledStyleUrls)
const themeLinks = new Map<string, HTMLLinkElement>()
const listeners = new Set<(state: ActiveThemeState) => void>()

let started = false
let stylesBootstrapped = false
let currentPrefsHandle: ThemePreferencesHandle | undefined
let currentState: ActiveThemeState | undefined
let storageStarted = false
let storageElement: HTMLElement | undefined
let unsubscribeStorage: (() => void) | undefined
let unsubscribePrefsChange: (() => void) | undefined

const TOOL_STORAGE_ID = "theme-preferences"

function ensureThemeLink(style: string) {
	if (themeLinks.has(style)) return
	const link = document.createElement("link")
	link.rel = "stylesheet"
	link.href = style
	document.head.appendChild(link)
	themeLinks.set(style, link)
}

function removeThemeLink(style: string) {
	const link = themeLinks.get(style)
	if (link) {
		link.remove()
		themeLinks.delete(style)
	}
}

function getMode(): "light" | "dark" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light"
}

function getPreferredThemeId(prefs: any): string {
	const mode = getMode()
	const themeId = prefs ? (mode === "dark" ? prefs.dark : prefs.light) : undefined
	return themeId || defaultThemeIds()[mode]
}

function snapshot(): ActiveThemeState {
	const prefs = currentPrefsHandle?.doc()
	const mode = getMode()
	const defaults = defaultThemeIds()
	return {
		mode,
		themeId: getPreferredThemeId(prefs),
		light: prefs?.light || defaults.light,
		dark: prefs?.dark || defaults.dark,
		preferencesUrl: currentPrefsHandle?.url,
	}
}

function emit() {
	currentState = snapshot()
	for (const listener of listeners) listener(currentState)
}

function applyTheme(themeId: string) {
	if (themeId) document.documentElement.setAttribute("theme", themeId)
}

function applyFromPrefs() {
	applyTheme(getPreferredThemeId(currentPrefsHandle?.doc()))
	emit()
}

function subscribeToProvider<T>(
	element: HTMLElement,
	selector: Record<string, unknown>,
	onValue: (value: T) => void
) {
	const view = element.closest("patchwork-view")
	const dispatchElement = (view as HTMLElement) ?? element
	const channel = new MessageChannel()
	const port = channel.port2
	const controller = new AbortController()

	port.addEventListener(
		"message",
		(event: MessageEvent) => {
			if ((event.data as any)?.type === "change") onValue((event.data as any).value as T)
		},
		{signal: controller.signal}
	)
	port.start()

	dispatchElement.dispatchEvent(
		new CustomEvent("patchwork:subscribe", {
			detail: {selector, port: channel.port1},
			bubbles: true,
			composed: true,
		})
	)

	return () => {
		if (controller.signal.aborted) return
		controller.abort()
		try {
			port.postMessage({type: "unsubscribe"})
		} catch {}
		try {
			port.close()
		} catch {}
	}
}

function ensureThemePreferencesShape(prefsHandle: ThemePreferencesHandle) {
	prefsHandle.change((doc: any) => {
		doc["@patchwork"] = {type: "theme-preferences"}
	})
}

async function useThemePreferencesHandle(prefsHandle: ThemePreferencesHandle) {
	ensureThemePreferencesShape(prefsHandle)

	if (currentPrefsHandle === prefsHandle) return
	if (
		currentPrefsHandle?.url &&
		prefsHandle.url &&
		currentPrefsHandle.url === prefsHandle.url
	) {
		return
	}

	unsubscribePrefsChange?.()
	currentPrefsHandle = prefsHandle
	applyFromPrefs()

	prefsHandle.on?.("change", applyFromPrefs)
	unsubscribePrefsChange = () => prefsHandle.off?.("change", applyFromPrefs)
}

async function useToolStoragePreferences(element: HTMLElement, storageUrl: string) {
	const repo = (element as any).repo ?? (window as any).repo
	if (!repo) return

	const prefsHandle = await repo.find(storageUrl)
	await useThemePreferencesHandle(prefsHandle)
}

function connectThemePreferences(element: HTMLElement) {
	if (currentPrefsHandle) return
	if (storageStarted && storageElement === element) return

	unsubscribeStorage?.()
	storageStarted = true
	storageElement = element

	let lastStorageUrl: string | undefined

	unsubscribeStorage = subscribeToProvider<string | undefined>(
		element,
		{type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID},
		(storageUrl) => {
			if (!storageUrl || storageUrl === lastStorageUrl) return
			lastStorageUrl = storageUrl
			useToolStoragePreferences(element, storageUrl).catch(() => {
				// Theme preferences are best-effort; keep the default theme.
			})
		}
	)
}

function watchThemeRegistry() {
	const themeRegistry = getRegistry("patchwork:theme") as any

	for (const theme of themeRegistry.all?.() || []) {
		if (theme.style) ensureThemeLink(theme.style)
	}

	themeRegistry.on("registered", (plugin: any) => {
		if (plugin.style) ensureThemeLink(plugin.style)
	})
	themeRegistry.on("removed", () => {
		const knownStyles = new Set(
			(themeRegistry.all?.() || [])
				.map((t: any) => t.style)
				.filter(Boolean)
		)
		for (const [style] of themeLinks) {
			if (!bundledStyles.has(style) && !knownStyles.has(style)) {
				removeThemeLink(style)
			}
		}
	})
}

// Load the bundled theme stylesheets and keep the registry-provided ones in
// sync. Idempotent — safe to call from every entry point. This is the CSS side
// of theming, independent of where the *active* theme id is sourced from.
function bootstrapThemeStyles() {
	if (stylesBootstrapped) return
	stylesBootstrapped = true
	for (const href of bundledStyleUrls) ensureThemeLink(href)
	watchThemeRegistry()
}

export function startActiveTheme(
	element?: HTMLElement,
	preferencesHandle?: ThemePreferencesHandle
) {
	if (preferencesHandle) {
		useThemePreferencesHandle(preferencesHandle).catch(() => {
			// Theme preferences are best-effort; keep the default theme.
		})
	} else if (element) {
		connectThemePreferences(element)
	}
	if (started) return
	started = true

	bootstrapThemeStyles()
	applyFromPrefs()

	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", applyFromPrefs)
}

/**
 * Drive the active theme from a `patchwork:current-theme` provider instead of
 * from local preferences. Used by the titlebar theme tool, which runs isolated
 * and mirrors whatever theme the host is showing: it applies each theme id the
 * provider emits and re-applies whenever that value changes.
 *
 * Stylesheets are still loaded locally so the referenced themes render; only
 * the *choice* of active theme comes from the provider. Deliberately does not
 * wire up preferences or the prefers-color-scheme listener — those would fight
 * the provider for control of the `theme` attribute.
 *
 * @returns an unsubscribe function.
 */
export function startActiveThemeFromProvider(element: HTMLElement) {
	bootstrapThemeStyles()

	return subscribeToProvider<string | ActiveThemeState | undefined>(
		element,
		{type: CURRENT_THEME_SELECTOR},
		(value) => {
			const themeId = typeof value === "string" ? value : value?.themeId
			if (themeId) applyTheme(themeId)
		}
	)
}

type CurrentThemeSubscribeEvent = CustomEvent<{
	selector: {type: string; [key: string]: unknown}
	port: MessagePort
}>

/**
 * Answer `patchwork:current-theme` subscriptions with the active theme id,
 * pushing a fresh value whenever the theme changes. This is the host-side
 * counterpart to {@link startActiveThemeFromProvider}: it lets isolated tools
 * (the titlebar theme tool) mirror the host's active theme across the isolation
 * boundary, where the theme is relayed by the providers bridge.
 *
 * The listener is installed on the given root (the theme tray installs it on
 * `document.documentElement`) so that bridged `patchwork:subscribe` events —
 * which bubble up to `<html>` — reach it. Implements the provider port protocol
 * directly to avoid a dependency on `@inkandswitch/patchwork-providers`.
 *
 * @returns an unsubscribe function that removes the listener and tears down any
 *   live subscriptions.
 */
export function serveCurrentThemeProvider(root: HTMLElement): () => void {
	const responders = new Set<() => void>()

	const onSubscribe = (event: Event) => {
		const detail = (event as CurrentThemeSubscribeEvent).detail
		if (!detail || detail.selector?.type !== CURRENT_THEME_SELECTOR) return
		event.stopPropagation()

		const port = detail.port
		let alive = true
		const emit = () => {
			if (!alive) return
			port.postMessage({type: "change", value: getActiveThemeState().themeId})
		}
		const removeThemeListener = onActiveThemeChange(emit)

		const stop = () => {
			if (!alive) return
			alive = false
			removeThemeListener()
			responders.delete(stop)
			try {
				port.close()
			} catch {}
		}
		responders.add(stop)

		port.onmessage = (e: MessageEvent) => {
			if ((e.data as any)?.type === "unsubscribe") stop()
		}
		port.start?.()
	}

	root.addEventListener("patchwork:subscribe", onSubscribe)

	return () => {
		root.removeEventListener("patchwork:subscribe", onSubscribe)
		for (const stop of [...responders]) stop()
	}
}

export function getActiveThemeState() {
	return currentState || snapshot()
}

/**
 * Best-effort color scheme for a theme. Prefers the plugin's declared
 * `colorScheme`, otherwise sniffs `color-scheme: light|dark` out of the theme's
 * stylesheet. Returns `undefined` when neither is available (treated as
 * scheme-agnostic by callers). Shared by the theme tray and the theme picker
 * tool so they group light/dark themes the same way.
 */
export async function detectColorScheme(theme: {
	colorScheme?: "light" | "dark"
	style?: string
}): Promise<"light" | "dark" | undefined> {
	if (theme.colorScheme) return theme.colorScheme
	if (!theme.style) return undefined
	try {
		const res = await fetch(theme.style)
		const css = await res.text()
		const match = css.match(/color-scheme:\s*(light|dark)/)
		return (match?.[1] as "light" | "dark") ?? undefined
	} catch {
		return undefined
	}
}

export function setThemeForCurrentMode(themeId: string) {
	const mode = getMode()
	setThemeForMode(mode, themeId)
}

export function setThemeForMode(mode: "light" | "dark", themeId: string) {
	currentPrefsHandle?.change((doc: any) => {
		doc[mode] = themeId
	})
}

export function hasThemePreferences() {
	return Boolean(currentPrefsHandle)
}

export function onActiveThemeChange(listener: (state: ActiveThemeState) => void) {
	listeners.add(listener)
	listener(getActiveThemeState())
	return () => listeners.delete(listener)
}
