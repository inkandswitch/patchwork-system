import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {getRepo} from "./repo"

export async function createFileDoc(
	blob: Blob,
	fileName?: string,
	mimeType?: string
): Promise<AutomergeUrl> {
	const repo = getRepo()
	if (!repo) throw new Error("No repo")
	const u8 = new Uint8Array(await blob.arrayBuffer())
	const ext = fileName
		? fileName.split(".").pop()
		: (mimeType || "").split("/")[1] || "bin"
	const name = fileName || "file-" + Date.now() + "." + ext
	const fh = await repo.create2({
		content: u8,
		extension: ext,
		mimeType: mimeType || "application/octet-stream",
		name: name,
		"@patchwork": {type: "file"},
	})
	return fh.url
}

export async function createRecordingDoc(
	audioBlob: Blob,
	duration: number
): Promise<{url: AutomergeUrl}> {
	const repo = getRepo()
	if (!repo) throw new Error("No repo")
	const u8 = new Uint8Array(await audioBlob.arrayBuffer())
	const ah = await repo.create2({content: u8})
	const rh = await repo.create2({
		title: "Voice Note",
		audio: ah.url,
		duration: duration,
		"@patchwork": {
			type: "recording",
			suggestedImportUrl: "automerge:2a5Rkw9LkqXfBAQZbcBWjTcf15Mc",
		},
	})
	return {url: rh.url}
}
