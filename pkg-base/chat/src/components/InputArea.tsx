import {createSignal, createEffect, createMemo, onMount, onCleanup, mapArray, Show, For, Index} from "solid-js"
import {useChat} from "../context/ChatContext"
import {useIdentity} from "../context/IdentityContext"
import {usePresence} from "../context/PresenceContext"
import {generateId} from "../lib/helpers"
import {createFileDoc} from "../lib/file-helpers"
import {createLoadedPlugins} from "../lib/slots"
import {Slot, useSlotContext} from "../context/SlotContext"
import {slashPlugins, matchSlashCommand} from "../lib/slash-plugins"
import {SVG_ICONS} from "../lib/svg-icons"
import {cmPromise} from "../lib/codemirror-setup"
import {ensureFontLoaded} from "../lib/blob-cache"
import {cuteAutocomplete} from "cute.txt/autocomplete"
import {cutePreview} from "cute.txt/preview"
import {createCompletionSpecs, chatRenderRow, emoticonImgSrc} from "../lib/completion"
import {autocompletePlugins, type AutocompleteCtx} from "../lib/autocomplete-plugins"
import {useChatSchema} from "../lib/syntax-schema"
import type {ChatMessage} from "../types"

type PendingFile = {blob: Blob; dataUrl?: string; name: string; mimeType: string}
type PendingEmbed = {url: string; toolId?: string; name?: string; type?: string}

export function InputArea(props: {
	replyToId: string | null
	onClearReply: () => void
	onReply: (msgId: string) => void
	onShowFontDialog?: () => void
	onShowEmoticonDialog?: () => void
	onToggleSidebar?: () => void
	onComputerCommand?: (sub: string) => void
	onModelCommand?: () => void
	onPinCommand?: (arg: string) => void
	onPluginCommand?: (arg: string) => void
	pendingFiles: PendingFile[]
	setPendingFiles: (fn: (prev: PendingFile[]) => PendingFile[]) => void
	pendingEmbeds: PendingEmbed[]
	setPendingEmbeds: (fn: (prev: PendingEmbed[]) => PendingEmbed[]) => void
}) {
	let inputWrapRef!: HTMLDivElement
	let inputRowRef!: HTMLDivElement
	const [cmView, setCmView] = createSignal<any>(null)
	const {handle, doc, repo, selector, element, hasFeature} = useChat()
	// Full SlotContext, handed to self-contained slash commands' `run` (e.g. `/call`
	// from the `call` bundle) so they drive the chat without the host hardcoding them.
	const slotCtx = useSlotContext()
	// Active slash commands with behaviour (`transform`) resolved inline for own
	// built-ins or loaded from a cross-bundle contribution's `.module` (chitter).
	const loadedSlash = createLoadedPlugins("chat:slash", slashPlugins, selector)
	// Extension seam for input-actions slot features (voice/gif live in chitter):
	// pre-send hooks may mutate the outgoing message; content-checks let an
	// otherwise-empty send fire (e.g. GIF-only).
	const preSendHooks: ((msg: any) => Promise<void> | void)[] = []
	const contentChecks: (() => boolean)[] = []
	const inputCaps = {
		registerPreSend: (fn: (msg: any) => Promise<void> | void) => {
			preSendHooks.push(fn)
			return () => { const i = preSendHooks.indexOf(fn); if (i >= 0) preSendHooks.splice(i, 1) }
		},
		registerContentCheck: (fn: () => boolean) => {
			contentChecks.push(fn)
			return () => { const i = contentChecks.indexOf(fn); if (i >= 0) contentChecks.splice(i, 1) }
		},
		focusInput: () => focusInput(),
	}
	const anyContentPending = () => contentChecks.some((c) => { try { return c() } catch { return false } })
	const {myName, myContactUrl, myFont, myAvatarUrl, myEmoticons, myFonts, chatProfileHandle} = useIdentity()
	const {broadcastPresence, peerFonts, peerEmoticons, presenceMap} = usePresence()

	const pendingFiles = () => props.pendingFiles
	const setPendingFiles = (fn: (prev: PendingFile[]) => PendingFile[]) => props.setPendingFiles(fn)
	const pendingEmbeds = () => props.pendingEmbeds
	const setPendingEmbeds = (fn: (prev: PendingEmbed[]) => PendingEmbed[]) => props.setPendingEmbeds(fn)
	const [inputText, setInputText] = createSignal("")
	const [cursorPos, setCursorPos] = createSignal(0)



	// Input autocomplete, driven by the cute.txt engine. The three built-in triggers
	// (slash/emoji/@mention) come from createCompletionSpecs; `chat:autocomplete`
	// providers (people, @selection, …) feed the @mention trigger. Providers are
	// `create`d once with a ctx that carries the live presence roster.
	const acCtx: AutocompleteCtx = {
		element,
		repo,
		selector,
		presence: () => Array.from(presenceMap().keys()),
	}
	const acProviders = createLoadedPlugins("chat:autocomplete", autocompletePlugins, selector)
	const mentionProviders = mapArray(acProviders, (p: any) =>
		typeof p?.create === "function" ? p.create(acCtx) : null
	)
	const completionSpecs = createCompletionSpecs({
		selector,
		myEmoticons,
		peerEmoticons: () => Object.fromEntries(peerEmoticons()),
		mentionProviders: () => mentionProviders().filter(Boolean) as any,
	})

	// Live-preview schema for the input box: the same cute.txt schema messages render
	// with, so `*bold*`/`:emoji:`/etc. preview as you type (reveal-on-cursor to edit).
	// Emoticons come from my own + peers' catalogs (no per-message maps here).
	const inputEmoticonUrls = createMemo(() => {
		const urls: Record<string, string> = {}
		for (const [, m] of peerEmoticons()) {
			for (const [name, url] of Object.entries(m)) if (!urls[name]) urls[name] = emoticonImgSrc(url as any)
		}
		for (const [name, url] of Object.entries(myEmoticons())) {
			if (!urls[name]) urls[name] = emoticonImgSrc(url as any)
		}
		return urls
	})
	const inputSchema = useChatSchema({
		selector,
		emoticonBlobUrls: inputEmoticonUrls,
		allowEmoticons: () => hasFeature("emoticons"),
		allowThink: () => hasFeature("computer"),
	})

	// Draft sync
	let draftHandle: any = null
	let draftSyncTimer: any = null
	let draftIsLocal = false

	function onDraftRemoteChange() {
		if (draftIsLocal) return
		const remote = draftHandle?.doc()?.text || ""
		if (remote !== getInputValue()) {
			setInputValue(remote)
		}
	}

	function getInputValue(): string {
		const cm = cmView()
		return cm ? cm.state.doc.toString() : ""
	}

	function setInputValue(text: string) {
		const cm = cmView()
		if (!cm) return
		cm.dispatch({
			changes: {from: 0, to: cm.state.doc.length, insert: text},
		})
	}

	function focusInput() {
		cmView()?.focus()
	}

	function updateInputState() {
		const cm = cmView()
		if (!cm) return
		setInputText(cm.state.doc.toString())
		setCursorPos(cm.state.selection.main.head)
	}

	onCleanup(() => {
		if (draftHandle) {
			try { draftHandle.off("change", onDraftRemoteChange) } catch {}
		}
		if (draftSyncTimer) { clearTimeout(draftSyncTimer); draftSyncTimer = null }
	})

	// ---- Draft sync ----
	function syncDraftToDoc() {
		if (!draftHandle) return
		const text = getInputValue()
		const current = draftHandle.doc()?.text || ""
		if (text === current) return
		draftIsLocal = true
		draftHandle.change((d: any) => { d.text = text })
		setTimeout(() => { draftIsLocal = false }, 50)
	}

	function scheduleDraftSync() {
		if (draftSyncTimer) clearTimeout(draftSyncTimer)
		draftSyncTimer = setTimeout(syncDraftToDoc, 300)
	}

	function clearDraft() {
		if (draftSyncTimer) { clearTimeout(draftSyncTimer); draftSyncTimer = null }
		if (!draftHandle) return
		draftIsLocal = true
		draftHandle.change((d: any) => { d.text = "" })
		setTimeout(() => { draftIsLocal = false }, 50)
	}

	async function initDraftDoc() {
		const chatProfileH = chatProfileHandle()
		if (!chatProfileH) return
		const chatUrl = handle.url
		const profile = chatProfileH.doc() as any
		const existingUrl = profile?.drafts?.[chatUrl]
		if (existingUrl) {
			try { draftHandle = await repo.find(existingUrl) } catch (e) {
				console.warn("[Chat] draft doc find:", e)
			}
		}
		if (!draftHandle) {
			draftHandle = await repo.create2({text: ""})
			chatProfileH.change((d: any) => {
				if (!d.drafts) d.drafts = {}
				d.drafts[chatUrl] = draftHandle.url
			})
		}
		// Restore draft into editor
		const saved = draftHandle.doc()?.text
		if (saved && !getInputValue()) {
			setInputValue(saved)
		}
		// Listen for remote changes (other device)
		draftHandle.on("change", onDraftRemoteChange)
	}

	// ---- CodeMirror ----
	onMount(async () => {
		try {
			const cm = await cmPromise
			const {EditorView, keymap} = cm
			const placeholderText = "Message " + (doc()?.title || "chat")

			setCmView(new EditorView({
				doc: "",
				extensions: [
					EditorView.theme({
						"&": {background: "transparent"},
						".cm-content": {
							maxHeight: "120px",
							caretColor: "var(--text-primary)",
							color: "var(--text-primary)",
							fontFamily: "inherit",
							fontSize: "15px",
							padding: "8px 12px",
						},
						".cm-scroller": {maxHeight: "120px", overflow: "auto"},
						".cm-line": {padding: "0"},
						"&.cm-focused": {outline: "none"},
						".cm-placeholder": {color: "var(--text-muted)"},
					}),
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({"aria-label": placeholderText}),
						// cute.txt live-preview: marks/emoji/embeds render as you type,
						// with reveal-on-cursor to edit. Same schema messages render with.
						...cutePreview(() => inputSchema()),
						// cuteAutocomplete adds a Prec.highest keymap (Arrow/Enter/Tab/Escape)
						// that wins only while the popup is open; when closed it returns
						// false so Enter falls through to sendMessage here.
						...cuteAutocomplete(() => completionSpecs, {
							className: "chat-autocomplete-pop",
							renderRow: chatRenderRow,
						}),
						keymap.of([
							{key: "Enter", run: () => { sendMessage(); return true }},
							{key: "Shift-Enter", run: () => false},
						]),
					EditorView.updateListener.of((update: any) => {
						if (update.docChanged || update.selectionSet) updateInputState()
						if (update.docChanged) {
							broadcastPresence(true)
							scheduleDraftSync()
						}
					}),
				],
				parent: inputWrapRef,
			}))

			// Initialize draft sync after CodeMirror is ready
			initDraftDoc()
		} catch (e) {
			console.error("[Chat] CodeMirror init failed:", e)
		}
	})

	// Keep input font in sync with user's chosen font
	createEffect(() => {
		const font = myFont()
		const cm = cmView()
		if (cm) {
			if (font) {
				ensureFontLoaded(font, myFonts(), peerFonts())
			}
			const contentEl = cm.contentDOM as HTMLElement
			if (contentEl) contentEl.style.fontFamily = font || ""
		}
	})

	// ---- Patchwork URL parsing ----
	const TINY_PW_RE = /https?:\/\/tiny\.patchwork\.inkandswitch\.com\/#[^\s]+/g
	function parsePatchworkLinks(text: string): {docUrl: string; title: string; type: string; toolId: string; originalUrl: string}[] {
		const links: {docUrl: string; title: string; type: string; toolId: string; originalUrl: string}[] = []
		let match
		while ((match = TINY_PW_RE.exec(text)) !== null) {
			try {
				const parsed = new URL(match[0])
				if (parsed.hash) {
					const params = new URLSearchParams(parsed.hash.slice(1))
					const docId = params.get("doc")
					if (docId) {
						links.push({
							docUrl: "automerge:" + docId,
							title: params.get("title")
								? decodeURIComponent(params.get("title")!.replace(/\+/g, " "))
								: "",
							type: params.get("type") || "",
							toolId: params.get("tool") || "",
							originalUrl: match[0],
						})
					}
				}
			} catch {}
		}
		TINY_PW_RE.lastIndex = 0
		return links
	}

	// ---- Send ----
	async function sendMessage() {
		const text = getInputValue().trim()
		if (!text && pendingFiles().length === 0 && pendingEmbeds().length === 0 && !anyContentPending()) return

		// Slash commands, dispatched via the chat:slash registry (filtered by this
		// tool's slashCommands feature). Side-effecting commands don't send a message.
		const activeSlash = loadedSlash()
		const slashMatch = matchSlashCommand(text, activeSlash)
		// Plugin-owned commands carry their own `run` (e.g. `/call` from the call
		// bundle) — dispatched generically with the SlotContext, no host switch.
		if (slashMatch?.plugin.run) {
			setInputValue("")
			void slashMatch.plugin.run(slotCtx, slashMatch.argText)
			return
		}
		if (slashMatch?.plugin.sideEffect) {
			setInputValue("")
			switch (slashMatch.plugin.sideEffect) {
				case "font-dialog": props.onShowFontDialog?.(); break
				case "emoticon-dialog": props.onShowEmoticonDialog?.(); break
				case "computer": props.onComputerCommand?.(slashMatch.argText.trim().toLowerCase() || "invite"); break
				case "model": props.onModelCommand?.(); break
				case "pin": props.onPinCommand?.(slashMatch.argText.trim()); break
				case "plugin": props.onPluginCommand?.(slashMatch.argText.trim()); break
			}
			return
		}

		// Upload pending files
		let imageUrl: string | null = null
		let imageName: string | null = null
		const fileAttachments: {url: string; name: string; mimeType: string}[] = []

		for (const pf of pendingFiles()) {
			try {
				const url = await createFileDoc(pf.blob, pf.name, pf.mimeType)
				handle.change((d: any) => {
					if (!d.docs) d.docs = []
					d.docs.push({url, type: "file", name: pf.name})
				})
				if (!imageUrl && pf.mimeType.startsWith("image/")) {
					imageUrl = url
					imageName = pf.name
				} else {
					fileAttachments.push({url, name: pf.name, mimeType: pf.mimeType})
				}
			} catch (e) {
				console.error("[Chat] file upload:", e)
			}
		}
		setPendingFiles(() => [])

		const slashCmd =
			slashMatch?.plugin.transform?.(slashMatch.argText) ?? null
		const sourceText = slashCmd ? slashCmd.text : text

		// Extract patchwork doc links from text and strip them
		const patchworkLinks = parsePatchworkLinks(sourceText)
		let msgText = sourceText
		for (const link of patchworkLinks) {
			msgText = msgText.replace(link.originalUrl, "").trim()
		}

		// Merge patchwork links + pending embeds
		const allEmbeds = [
			...patchworkLinks.map(l => ({url: l.docUrl, toolId: l.toolId, name: l.title, type: l.type})),
			...pendingEmbeds(),
		]

		const msgData: any = {
			id: generateId(),
			name: myName(),
			text: msgText || "",
			timestamp: Date.now(),
		}

		if (slashCmd?.overrideFont) msgData.font = slashCmd.overrideFont
		else if (myFont()) msgData.font = myFont()
		const avatarUrl = myAvatarUrl()
		if (avatarUrl) msgData.avatarUrl = avatarUrl
		const contactUrl = myContactUrl()
		if (contactUrl) msgData.contactUrl = contactUrl
		if (props.replyToId) msgData.replyTo = props.replyToId
		if (imageUrl) {
			msgData.imageUrl = imageUrl
			msgData.imageName = imageName
		}
		if (slashCmd?.marquee) msgData.marquee = true
		if (slashCmd?.action) msgData.action = true
		if (slashCmd?.overrideColor) msgData.color = slashCmd.overrideColor
		if (fileAttachments.length > 0) msgData.files = fileAttachments

		// Run input-actions pre-send hooks (e.g. GIF selfie capture) — they may
		// add fields such as `gifSelfieUrl` to the outgoing message.
		for (const hook of preSendHooks) {
			try { await hook(msgData) } catch (e) { console.warn("[Chat] pre-send hook:", e) }
		}

		// Add embeds (from patchwork links in text + pending embeds from drag/drop)
		if (allEmbeds.length > 0) {
			msgData.embeds = allEmbeds.map(e => ({
				docUrl: e.url,
				toolId: e.toolId,
				title: e.name,
				type: e.type,
			}))
			// Also add to chat docs list
			for (const e of allEmbeds) {
				handle.change((d: any) => {
					if (!d.docs) d.docs = []
					if (!d.docs.find((dl: any) => dl.url === e.url)) {
						d.docs.push({url: e.url, type: e.type || "unknown", name: e.name || "doc"})
					}
				})
			}
			setPendingEmbeds(() => [])
		}

		if (!msgText && !imageUrl && !msgData.gifSelfieUrl && fileAttachments.length === 0 && allEmbeds.length === 0) return

		// Embed emoticon URLs referenced in text
		const usedEmoticons: Record<string, string> = {}
		const emMatches = (msgText || "").matchAll(/:([a-zA-Z0-9_-]+):/g)
		const em = myEmoticons()
		for (const m of emMatches) {
			const name = m[1]
			if (em[name]) usedEmoticons[name] = em[name]
		}
		if (Object.keys(usedEmoticons).length > 0) msgData.emoticons = usedEmoticons

		const msgHandle = await repo.create2(msgData)
		handle.change((d: any) => {
			if (!d.messages) d.messages = []
			d.messages.push({ref: true, url: msgHandle.url, timestamp: msgData.timestamp})
		})

		setInputValue("")
		clearDraft()
		focusInput()
		props.onClearReply()
	}

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items
		if (!items) return
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				e.preventDefault()
				const blob = item.getAsFile()
				if (!blob) continue
				const reader = new FileReader()
				reader.onload = () => {
					setPendingFiles(prev => [
						...prev,
						{
							blob,
							dataUrl: reader.result as string,
							name: "paste-" + Date.now() + "." + (blob.type.split("/")[1] || "png"),
							mimeType: blob.type,
						},
					])
				}
				reader.readAsDataURL(blob)
			}
		}
	}

	return (
		<div class="chat-input-wrapper">
			{/* Reply bar */}
			<Show when={props.replyToId}>
				<div class="chat-reply-bar show">
					<span>Replying to message</span>
					<span class="chat-reply-bar-text" />
					<button
						class="chat-reply-bar-close"
						innerHTML={SVG_ICONS.close}
						on:click={props.onClearReply}
					/>
				</div>
			</Show>

			{/* Paste preview */}
			<Show when={pendingFiles().length > 0}>
				<div class="chat-paste-preview show">
					<For each={pendingFiles()}>
						{(f) =>
							f.dataUrl ? (
								<img src={f.dataUrl} style="max-height:50px;border-radius:4px" />
							) : (
								<div class="chat-paste-file">
									<span class="chat-paste-file-name">{f.name}</span>
								</div>
							)
						}
					</For>
					<button
						class="chat-paste-preview-close"
						innerHTML={SVG_ICONS.close}
						on:click={() => setPendingFiles(() => [])}
					/>
				</div>
			</Show>

			{/* Pending embeds */}
			<Show when={pendingEmbeds().length > 0}>
				<div class="chat-paste-preview show">
					<Index each={pendingEmbeds()}>
						{(e, i) => (
							<div class="chat-paste-embed">
								<span class="chat-paste-embed-name">{e().name || e().url.slice(0, 20) + "..."}</span>
								<button
									class="chat-paste-embed-remove"
									innerHTML={SVG_ICONS.close}
									on:click={() => setPendingEmbeds(prev => prev.filter((_, j) => j !== i))}
								/>
							</div>
						)}
					</Index>
					<button
						class="chat-paste-preview-close"
						innerHTML={SVG_ICONS.close}
						on:click={() => setPendingEmbeds(() => [])}
					/>
				</div>
			</Show>

			{/* Input row */}
			<div
				ref={inputRowRef}
				class="chat-input-row"
				style={{position: "relative"}}
				on:paste={handlePaste}
			>
				<Slot name="input-actions-left" extra={inputCaps} />
				<div
				ref={inputWrapRef}
				class="chat-input-wrap"
				on:dragover={(e) => {
					e.preventDefault()
					if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
				}}
				on:drop={(e) => {
					const dt = e.dataTransfer
					if (!dt) return
					const dndData = dt.getData("text/x-patchwork-dnd")
					const urlsData = dt.getData("text/x-patchwork-urls")
					if (!dndData && !urlsData) return
					e.preventDefault()
					e.stopPropagation()
					let items: {url: string; type?: string; name?: string; toolId?: string}[] | null = null
					if (dndData) {
						try {
							const parsed = JSON.parse(dndData)
							if (parsed.items?.length) items = parsed.items
						} catch {}
					}
					if (!items && urlsData) {
						try {
							const urls = JSON.parse(urlsData)
							if (Array.isArray(urls)) items = urls.map((u: string) => ({url: u}))
						} catch {}
					}
					if (items) {
						for (const item of items) {
							if (!item.url) continue
							if (pendingEmbeds().some(pe => pe.url === item.url)) continue
							setPendingEmbeds(prev => [...prev, item])
						}
						focusInput()
					}
				}}
			/>

				<Slot name="input-actions-right" extra={inputCaps} />
				<button
					class="chat-input-btn"
					title="Send"
					innerHTML={SVG_ICONS.send}
					on:click={sendMessage}
				/>
			</div>
		</div>
	)
}
