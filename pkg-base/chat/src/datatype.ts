import type {ChatDoc} from "./types"

// Shared skeleton. `plugins` decides which full-tier features are active.
function base(doc: ChatDoc, title: string, plugins: string[]) {
	doc.title = title
	doc.messages = []
	doc.docs = []
	doc.plugins = plugins
}

const getTitle = (doc: ChatDoc) => doc.title || "chat"
const setTitle = (doc: ChatDoc, title: string) => {
	doc.title = title
}

// `chat` — the base preset: just the computer. A plain chat that grows itself via
// `/plugin load` (or by loading the `chitter` bundle). The "everything" preset is
// the chitter bundle's `chitter` datatype.
export const ChatDatatype = {
	init(doc: ChatDoc) {
		base(doc, "chat " + new Date().toLocaleString(), ["computer", "model"])
	},
	getTitle,
	setTitle,
}
