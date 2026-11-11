// File document types

import type {ImmutableString} from "@automerge/automerge-repo/slim"
import type {UnixFileEntry} from "@inkandswitch/patchwork-filesystem"

export type TextFileDoc = {
	name: string
	extension: string
	mimeType: string
	content: string
}

export type BinaryFileDoc = {
	name: string
	extension: string
	mimeType: string
	content: Uint8Array
}

export type ImmutableStringFileDoc = {
	name: string
	extension: string
	mimeType: string
	content: ImmutableString
}

export type FileDoc = UnixFileEntry
