import {createMemo} from "solid-js"
import type {FileDoc} from "../types"
import {createBinaryUrl} from "../utils"
import {isBinaryFileDoc} from "../datatype"

export type ImageFileDoc = FileDoc & {
	extension: "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
}

export function ImageFileViewer(props: {doc: FileDoc}) {
	const imgUrl = createMemo(() => {
		if (isBinaryFileDoc(props.doc)) {
			return createBinaryUrl(props.doc.content, props.doc.mimeType)
		}
		return undefined
	})

	return imgUrl() ? (
		<img
			src={imgUrl()}
			alt={props.doc.name}
			style={{
				"max-width": "100%",
				"max-height": "100%",
				"object-fit": "contain",
			}}
		/>
	) : (
		<div
			style={{
				background: "var(--editor-fill)",
				color: "var(--editor-line)",
			}}>
			No image to display
		</div>
	)
}
