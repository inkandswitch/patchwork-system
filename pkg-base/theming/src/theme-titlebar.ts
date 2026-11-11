import {startActiveThemeFromProvider} from "./active-theme.ts"

export function ThemeTitlebarTool(_handle: any, element: HTMLElement) {
	const unsubscribe = startActiveThemeFromProvider(element)
	element.style.width = "0"
	element.style.height = "0"
	element.style.overflow = "hidden"
	element.style.flex = "0 0 0"
	element.style.pointerEvents = "none"

	return () => {
		unsubscribe()
	}
}
