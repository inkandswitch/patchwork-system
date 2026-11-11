import type {AutomergeUrl} from "@automerge/automerge-repo/slim"

export interface ChatMessage {
	id: string
	name: string
	text: string
	timestamp: number
	contactUrl?: AutomergeUrl
	font?: string
	avatarUrl?: AutomergeUrl
	replyTo?: string
	imageUrl?: AutomergeUrl
	imageName?: string
	imageWidth?: number
	imageHeight?: number
	voiceUrl?: AutomergeUrl
	voiceDuration?: number
	gifSelfieUrl?: AutomergeUrl
	reactions?: Record<string, string[]>
	emoticons?: Record<string, AutomergeUrl>
	embeds?: DocEmbed[]
	action?: boolean
	marquee?: boolean
	color?: string
	files?: FileAttachment[]
	streaming?: boolean
	isComputer?: boolean
	richBlocks?: RichBlock[]
	quickReplies?: string[] // ask_user: suggested answers shown as clickable buttons

	// Runtime fields (not persisted)
	_loading?: boolean
	_rawIdx?: number
	_ref?: ChatMessageRef
}

export interface ChatMessageRef {
	ref: true
	url: AutomergeUrl
	timestamp?: number
}

export interface DocEmbed {
	docUrl: AutomergeUrl
	toolId?: string
	title?: string
	type?: string
	originalUrl?: string
}

export interface FileAttachment {
	url: AutomergeUrl
	name: string
	mimeType: string
}

export interface DocLink {
	name: string
	type: string
	url: AutomergeUrl
	icon?: string
	copyOf?: AutomergeUrl
}

export interface ChatDoc {
	title: string
	messages: (ChatMessage | ChatMessageRef)[]
	docs: DocLink[]
	// Explicit list of active full-tier plugin ids. Core-tier plugins are always
	// on and are NOT listed here. Seeded by the datatype (empty for `chat`, the
	// full built-in set for `chitterchatter`); mutated live via `/plugin`.
	plugins?: string[]
	emoticons?: Record<string, {url: AutomergeUrl; addedBy: string}>
	fonts?: Record<string, {url: AutomergeUrl; addedBy: string}>
	hasComputer?: boolean
}

export interface ChatProfileDoc {
	font?: string
	readPositions: Record<string, number>
	emoticons?: Record<string, AutomergeUrl>
	fonts?: Record<string, AutomergeUrl>
	drafts?: Record<string, AutomergeUrl>
}

export interface EmoticonInfo {
	url: AutomergeUrl
	owner: string
	mine: boolean
	fromChat?: boolean
}

export interface FontInfo {
	url: AutomergeUrl
	owner: string
	mine: boolean
}

export interface RichBlock {
	type: string
	content: string
	meta?: string
	result?: string
}

export interface PresenceInfo {
	timestamp: number
	typing: boolean
	avatarUrl?: AutomergeUrl
	color?: string
	active: boolean
}

export interface PresencePayload {
	type: "presence"
	name: string
	typing: boolean
	avatarUrl?: AutomergeUrl
	color?: string
	active: boolean
	timestamp: number
	emoticons?: Record<string, AutomergeUrl>
	fonts?: Record<string, AutomergeUrl>
}
