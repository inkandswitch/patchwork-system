import {createMemo} from "solid-js"
import type {FileDoc} from "../types"
import {isBinaryFileDoc} from "../datatype"

export type HTMLFileDoc = FileDoc & {
	extension: "html" | "htm"
}

export const isHTMLFile = (doc: FileDoc) => {
	return (
		["html", "htm"].includes(doc.extension?.toLowerCase()) ||
		doc.mimeType === "text/html"
	)
}

export function HTMLFileViewer(props: {doc: FileDoc}) {
	const textData = createMemo(() => {
		if (!props.doc) {
			return ""
		}

		if (isBinaryFileDoc(props.doc)) {
			return new TextDecoder().decode(props.doc.content)
		} else {
			return props.doc.content.toString()
		}
	})

	const blobUrl = createMemo(() => {
		const content = textData()
		if (!content) return ""
		const blob = new Blob([content], {type: "text/html"})
		return URL.createObjectURL(blob)
	})

	return (
		<div style={{overflow: "auto", height: "100%"}}>
			{textData() ? (
				<iframe
					src={blobUrl()}
					style={{width: "100%", height: "100%", border: "none"}}
				/>
			) : (
				<div
					style={{
						display: "flex",
						"align-items": "center",
						"justify-content": "center",
						height: "100%",
						background: "var(--editor-fill)",
						color: "var(--editor-line)",
					}}>
					Loading...
				</div>
			)}
		</div>
	)
}
