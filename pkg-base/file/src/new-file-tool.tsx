import {render} from "solid-js/web"
import {DocHandle} from "@automerge/automerge-repo/slim"
import {PatchworkViewElement} from "@inkandswitch/patchwork-elements"
import type {FileDoc} from "./types"
import {getMimeType} from "./mime-types"

function NewFilePrompt(props: {handle: DocHandle<FileDoc>}) {
	let inputRef!: HTMLInputElement

	function submit() {
		const filename = inputRef.value.trim()
		if (!filename) return

		const lastDot = filename.lastIndexOf(".")
		const extension = lastDot > 0 ? filename.slice(lastDot) : ""
		const mimeType = extension ? getMimeType(extension) : "text/plain"

		props.handle.change((doc: any) => {
			doc.name = filename
			doc.extension = extension
			doc.mimeType = mimeType
			doc.content = ""
			doc["@patchwork"].type = "file"
		})
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault()
			submit()
		}
	}

	return (
		<div
			style={{
				display: "flex",
				"flex-direction": "column",
				"align-items": "center",
				"justify-content": "center",
				height: "100%",
				gap: "12px",
				"font-family": "system-ui, sans-serif",
			}}>
			<label
				for="new-file-name"
				style={{"font-size": "14px", color: "#666"}}>
				Enter a filename
			</label>
			<input
				ref={inputRef!}
				id="new-file-name"
				type="text"
				placeholder="hello.tsx"
				autofocus
				onKeyDown={onKeyDown}
				style={{
					"font-size": "16px",
					padding: "8px 12px",
					border: "var(--studio-border-width, 1px) var(--studio-border-style, solid) #ccc",
					"border-radius": "6px",
					"min-width": "240px",
					outline: "none",
				}}
				onFocus={(e) => {
					e.currentTarget.style["border-color"] = "#888"
				}}
				onBlur={(e) => {
					e.currentTarget.style["border-color"] = "#ccc"
				}}
			/>
			<button
				onClick={submit}
				style={{
					"font-size": "14px",
					padding: "6px 16px",
					border: "var(--studio-border-width, 1px) var(--studio-border-style, solid) #ccc",
					"border-radius": "6px",
					background: "#f5f5f5",
					cursor: "var(--studio-cursor-pointer, pointer)",
				}}>
				Create
			</button>
		</div>
	)
}

export function NewFileTool(
	handle: DocHandle<FileDoc>,
	element: PatchworkViewElement
) {
	const dispose = render(
		() => <NewFilePrompt handle={handle} />,
		element
	)

	return () => {
		dispose()
	}
}
