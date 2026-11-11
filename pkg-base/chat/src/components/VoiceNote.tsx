import {createSignal, createEffect, onCleanup, Show} from "solid-js"
import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {loadAudioUrl} from "../lib/blob-cache"
import {formatDuration} from "../lib/helpers"
import {SVG_ICONS} from "../lib/svg-icons"
import {transcribeVoiceNote, getExistingTranscription} from "../lib/transcription"

export function VoiceNote(props: {voiceUrl: AutomergeUrl; duration: number}) {
	const [playing, setPlaying] = createSignal(false)
	const [audioEl, setAudioEl] = createSignal<HTMLAudioElement | null>(null)
	const [transcription, setTranscription] = createSignal<string | null>(null)
	const [transcribing, setTranscribing] = createSignal(false)

	// Generate random waveform bars
	const bars = Array.from({length: 20}, () => 3 + Math.random() * 18)

	// Auto-transcribe when voiceUrl changes
	createEffect(async () => {
		const url = props.voiceUrl
		if (!url) return
		setTranscription(null)
		setTranscribing(false)
		const existing = await getExistingTranscription(url)
		if (existing) {
			setTranscription(existing)
		} else {
			setTranscribing(true)
			transcribeVoiceNote(url, (text) => {
				setTranscription(text)
				setTranscribing(false)
			})
		}
	})

	function startTranscription() {
		if (transcribing() || transcription()) return
		setTranscribing(true)
		transcribeVoiceNote(props.voiceUrl, (text) => {
			setTranscription(text)
			setTranscribing(false)
		})
	}

	async function togglePlay() {
		let audio = audioEl()
		if (!audio) {
			const url = await loadAudioUrl(props.voiceUrl)
			if (!url) return
			audio = new Audio(url)
			audio.addEventListener("ended", () => setPlaying(false))
			setAudioEl(audio)
		}
		if (playing()) {
			audio.pause()
			setPlaying(false)
		} else {
			audio.play()
			setPlaying(true)
		}
	}

	onCleanup(() => {
		const audio = audioEl()
		if (audio) {
			audio.pause()
			audio.src = ""
		}
	})

	return (
		<div class="chat-voice-note">
			<button
				class="chat-voice-play-btn"
				on:click={togglePlay}
				innerHTML={playing() ? SVG_ICONS.pause : SVG_ICONS.play}
			/>
			<div class="chat-voice-waveform">
				{bars.map((h) => (
					<div
						class="chat-voice-bar"
						style={{height: h + "px"}}
					/>
				))}
			</div>
			<span class="chat-voice-duration">{formatDuration(props.duration)}</span>
			<Show when={transcribing()}>
				<div class="chat-voice-transcription chat-voice-transcribing">transcribing...</div>
			</Show>
			<Show when={transcription()}>
				<div class="chat-voice-transcription">{transcription()}</div>
			</Show>
			<Show when={!transcription() && !transcribing()}>
				<button class="chat-voice-transcribe-btn" on:click={startTranscription}>transcribe</button>
			</Show>
		</div>
	)
}
