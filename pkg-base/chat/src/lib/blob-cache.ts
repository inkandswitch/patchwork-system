import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {getRepo} from "./repo"

const blobCache = new Map<string, string>()

export async function loadBlobUrl(automergeUrl: AutomergeUrl): Promise<string | null> {
	if (!automergeUrl) return null
	if (blobCache.has(automergeUrl)) return blobCache.get(automergeUrl)!
	try {
		const repo = getRepo()
		if (!repo) return null
		const fh = await repo.find(automergeUrl)
		const doc = fh.doc()
		if (doc?.content) {
			const bytes =
				doc.content instanceof Uint8Array
					? doc.content
					: new Uint8Array(doc.content)
			const blobOpts = doc.mimeType ? {type: doc.mimeType} : {}
			const url = URL.createObjectURL(new Blob([bytes], blobOpts))
			blobCache.set(automergeUrl, url)
			return url
		}
	} catch (e) {
		// silently fail
	}
	return null
}

export async function loadAudioUrl(automergeUrl: AutomergeUrl): Promise<string | null> {
	try {
		const repo = getRepo()
		if (!repo) return null
		const rh = await repo.find(automergeUrl)
		const rd = rh.doc()
		if (!rd?.audio) return null
		const ah = await repo.find(rd.audio)
		const ad = ah.doc()
		if (ad?.content) {
			const bytes =
				ad.content instanceof Uint8Array
					? ad.content
					: new Uint8Array(ad.content)
			return URL.createObjectURL(
				new Blob([bytes], {type: "audio/webm;codecs=opus"})
			)
		}
	} catch (e) {
		// silently fail
	}
	return null
}

export function getCachedBlobUrl(automergeUrl: string): string | undefined {
	return blobCache.get(automergeUrl)
}

export function setCachedBlobUrl(automergeUrl: string, url: string) {
	blobCache.set(automergeUrl, url)
}

const loadedFontFaces = new Set<string>()

export async function ensureFontLoaded(
	fontName: string,
	myFonts: Record<string, AutomergeUrl>,
	peerFonts: Map<string, Record<string, AutomergeUrl>>
): Promise<void> {
	if (!fontName || loadedFontFaces.has(fontName)) return
	// Find the font URL from own fonts or peer fonts
	let url: AutomergeUrl | undefined = myFonts[fontName]
	if (!url) {
		for (const [, fonts] of peerFonts) {
			if (fonts[fontName]) { url = fonts[fontName]; break }
		}
	}
	if (!url) return
	try {
		const blobUrl = await loadBlobUrl(url)
		if (!blobUrl) return
		const face = new FontFace(fontName, "url(" + blobUrl + ")")
		await face.load()
		document.fonts.add(face)
		loadedFontFaces.add(fontName)
	} catch (e) {
		console.warn("[Chat] font load failed:", fontName, e)
	}
}
