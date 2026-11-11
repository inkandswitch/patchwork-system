// "New File" datatype — a listed datatype that acts as a creation prompt.
// Once the user enters a filename, the doc flips to type "file".

import type {FileDoc} from "./types"

export const NewFileDatatype = {
	init(doc: FileDoc) {
		doc.name = ""
		doc.extension = ""
		doc.mimeType = ""
		doc.content = ""
	},

	getTitle(doc: FileDoc) {
		return doc.name || "New File"
	},

	setTitle(doc: FileDoc, title: string) {
		doc.name = title
	},
}
