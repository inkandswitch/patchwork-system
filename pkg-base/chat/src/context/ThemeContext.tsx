import {
	createContext,
	useContext,
	createSignal,
	onMount,
	onCleanup,
	type ParentComponent,
	type Accessor,
} from "solid-js"

interface ThemeContextValue {
	isLightBg: Accessor<boolean>
}

const ThemeCtx = createContext<ThemeContextValue>()

/**
 * Theming comes from the Patchwork system theme. The host sets `[theme]`,
 * `color-scheme` and the `--studio-*` design tokens; chat.css maps those onto
 * the `--bg-*` / `--text-*` / `--accent*` names the rest of the styles use.
 *
 * This provider computes no colours — it only derives `isLightBg`
 * from the *rendered* background so the bits that still need to know (syntax
 * highlighting, named-colour resolution) pick the right light/dark variant. It
 * re-evaluates when the host swaps themes at runtime.
 */
export const ThemeProvider: ParentComponent<{rootEl: HTMLElement}> = (props) => {
	const [isLightBg, setIsLightBg] = createSignal(false)

	function luminance(color: string): number {
		const m = color.match(/[\d.]+/g)
		if (!m || m.length < 3) return 0
		const [r, g, b] = m.map(Number)
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
	}

	function recompute() {
		// `.chat-root` background resolves to var(--editor-fill); the computed
		// value is always an rgb()/rgba() string, so luminance is reliable.
		const bg = getComputedStyle(props.rootEl).backgroundColor
		setIsLightBg(luminance(bg) > 0.5)
	}

	let mo: MutationObserver | null = null
	let mq: MediaQueryList | null = null
	const onChange = () => recompute()

	onMount(() => {
		recompute()
		// The host can switch themes at runtime (theme editor) or follow the OS.
		mo = new MutationObserver(onChange)
		mo.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["theme", "class", "style"],
		})
		const el = props.rootEl.closest("[theme]")
		if (el) mo.observe(el, {attributes: true, attributeFilter: ["theme", "style"]})
		mq = window.matchMedia("(prefers-color-scheme: dark)")
		mq.addEventListener("change", onChange)
	})

	onCleanup(() => {
		mo?.disconnect()
		mq?.removeEventListener("change", onChange)
	})

	return (
		<ThemeCtx.Provider value={{isLightBg}}>{props.children}</ThemeCtx.Provider>
	)
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeCtx)
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
	return ctx
}
