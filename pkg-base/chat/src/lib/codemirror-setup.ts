import type {EMOJI_ALIASES} from "./emoji-data"
import type {EmoticonInfo} from "../types"

// Lazy-load CodeMirror modules from importmap
export const cmPromise = Promise.all([
	import("@codemirror/view"),
	import("@codemirror/state"),
]).then(([viewMod, stateMod]) => ({...viewMod, ...stateMod}))

export type CMModules = Awaited<typeof cmPromise>

// Emoji inline widget for CodeMirror
export function createEmojiWidget(cm: CMModules) {
	const {WidgetType} = cm

	class EmojiWidget extends WidgetType {
		src: string
		alt: string
		isImage: boolean
		constructor(src: string, alt: string, isImage: boolean) {
			super()
			this.src = src
			this.alt = alt
			this.isImage = isImage
		}
		eq(other: EmojiWidget) {
			return this.src === other.src
		}
		toDOM() {
			if (this.isImage) {
				const img = document.createElement("img")
				img.className = "chat-emoticon-inline"
				img.src = this.src
				img.alt = this.alt
				img.style.cssText = "height:1.3em;vertical-align:middle;display:inline;"
				return img
			}
			const span = document.createElement("span")
			span.textContent = this.src
			span.title = this.alt
			return span
		}
		ignoreEvent() {
			return false
		}
	}

	return EmojiWidget
}

// Formatting inline widget for bold/italic/etc preview
export function createFormattingWidget(cm: CMModules) {
	const {WidgetType} = cm

	class FormattingWidget extends WidgetType {
		html: string
		constructor(html: string) {
			super()
			this.html = html
		}
		eq(other: FormattingWidget) {
			return this.html === other.html
		}
		toDOM() {
			const span = document.createElement("span")
			span.innerHTML = this.html
			return span
		}
		ignoreEvent() {
			return false
		}
	}

	return FormattingWidget
}
