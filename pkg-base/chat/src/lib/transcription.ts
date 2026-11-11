/**
 * Voice-note transcription — thin wrappers over @chee/patchwork-transcript.
 *
 * The library's `transcribeDoc` already implements exactly what chat needs: read
 * a recording doc ({ audio: <fileDocUrl> }), transcribe its audio, and cache the
 * text back onto `.transcription` (its defaults — audioField "audio", textField
 * "transcription", mime "audio/webm;codecs=opus" — match chat's doc shape). The
 * model + provider come from the account doc.
 */
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {
	transcribeDoc,
	getExistingTranscription as getExisting,
} from "@chee/patchwork-transcript"

export async function transcribeVoiceNote(
	voiceUrl: AutomergeUrl,
	onResult?: (text: string) => void
): Promise<void> {
	await transcribeDoc(voiceUrl, {onResult})
}

export function getExistingTranscription(
	voiceUrl: AutomergeUrl
): Promise<string | null> {
	return getExisting(voiceUrl)
}
