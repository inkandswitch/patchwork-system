import {createMemo} from "solid-js"
import type {FileDoc} from "../types"
import {createBinaryUrl} from "../utils"
import {isBinaryFileDoc} from "../datatype"

export type PDFFileDoc = FileDoc & {
	extension: "pdf"
	mimeType: "application/pdf"
}

export const isPDFFile = (doc: FileDoc): doc is PDFFileDoc => {
	return (
		doc.extension?.toLowerCase() === "pdf" || doc.mimeType === "application/pdf"
	)
}

export function PDFFileViewer(props: {doc: FileDoc}) {
	const pdfUrl = createMemo(() => {
		if (isBinaryFileDoc(props.doc)) {
			// Not props.doc.mimeType: isPDFFile also matches on the extension
			// alone, so the stored mimeType may be missing or octet-stream.
			return createBinaryUrl(props.doc.content, "application/pdf")
		}
		return undefined
	})

	return (
		<div style={{overflow: "auto", height: "100%"}}>
			{pdfUrl() ? (
				<iframe
					src={pdfUrl()}
					style={{width: "100%", height: "100%", border: "none"}}
					title={props.doc.name}
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
					No PDF to display
				</div>
			)}
		</div>
	)
}
