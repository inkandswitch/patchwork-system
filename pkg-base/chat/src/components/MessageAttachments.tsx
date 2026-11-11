import {Show, For, createMemo, createSignal, onMount} from "solid-js"
import type {ChatMessage, DocEmbed} from "../types"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"
import {useChat} from "../context/ChatContext"
import {getRepo} from "../lib/repo"
import {SVG_ICONS} from "../lib/svg-icons"

export function MessageAttachments(props: {msg: ChatMessage}) {
	return (
		<>
			<Show when={props.msg.imageUrl}>
				<ImageAttachment
					imageUrl={props.msg.imageUrl!}
					imageName={props.msg.imageName}
					width={props.msg.imageWidth}
					height={props.msg.imageHeight}
					msg={props.msg}
					sizeKey="image"
				/>
			</Show>
			<Show when={props.msg.files?.length}>
				<For each={props.msg.files}>
					{(file) => (
						<FileAttachment url={file.url} name={file.name} mimeType={file.mimeType} />
					)}
				</For>
			</Show>
			<Show when={props.msg.embeds?.length}>
				<For each={props.msg.embeds}>
					{(embed, i) => <DocEmbedView embed={embed} msg={props.msg} embedIndex={i()} />}
				</For>
			</Show>
		</>
	)
}

function ResizeHandle(props: {
	containerRef: HTMLElement
	msg: ChatMessage
	sizeKey: string
}) {
	function handlePointerDown(e: PointerEvent) {
		e.preventDefault()
		e.stopPropagation()
		const grip = e.currentTarget as HTMLElement
		grip.setPointerCapture(e.pointerId)
		const startX = e.clientX
		const startY = e.clientY
		const startW = props.containerRef.offsetWidth
		const startH = props.containerRef.offsetHeight

		function onMove(ev: PointerEvent) {
			const w = Math.max(100, startW + ev.clientX - startX)
			const h = Math.max(60, startH + ev.clientY - startY)
			props.containerRef.style.width = w + "px"
			props.containerRef.style.height = h + "px"
		}

		function onUp(ev: PointerEvent) {
			grip.releasePointerCapture(ev.pointerId)
			grip.removeEventListener("pointermove", onMove)
			grip.removeEventListener("pointerup", onUp)
			grip.removeEventListener("lostpointercapture", onUp)
			const w = props.containerRef.offsetWidth
			const h = props.containerRef.offsetHeight
			persistDimensions(props.msg, props.sizeKey, w, h)
		}

		grip.addEventListener("pointermove", onMove)
		grip.addEventListener("pointerup", onUp)
		grip.addEventListener("lostpointercapture", onUp)
	}

	return (
		<div class="chat-resize-handle" on:pointerdown={handlePointerDown}>
			<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M9 1L1 9M9 5L5 9M9 8L8 9" />
			</svg>
		</div>
	)
}

function persistDimensions(msg: ChatMessage, key: string, w: number, h: number) {
	const repo = getRepo()
	if (!repo) return
	const ref = msg._ref as any
	if (ref?.url) {
		repo.find(ref.url).then((cached: any) => {
			cached.change((d: any) => {
				d[key + "Width"] = w
				d[key + "Height"] = h
			})
		})
	}
}

function ImageAttachment(props: {
	imageUrl: string
	imageName?: string
	width?: number
	height?: number
	msg: ChatMessage
	sizeKey: string
}) {
	let wrapRef!: HTMLDivElement
	const src = createMemo(() => automergeUrlToServiceWorkerUrl(props.imageUrl as any))

	return (
		<div
			ref={wrapRef}
			class="chat-msg-image-wrap"
			style={{
				width: (props.width || 350) + "px",
				height: props.height ? props.height + "px" : "auto",
				position: "relative",
			}}
		>
			<Show when={src()}>
				<img
					class="chat-msg-image"
					src={src()!}
					alt={props.imageName || "image"}
				/>
				<ResizeHandle containerRef={wrapRef} msg={props.msg} sizeKey={props.sizeKey} />
			</Show>
		</div>
	)
}

function FileAttachment(props: {url: string; name: string; mimeType: string}) {
	const src = createMemo(() => automergeUrlToServiceWorkerUrl(props.url as any))

	const isImage = () => props.mimeType?.startsWith("image/")
	const isVideo = () => props.mimeType?.startsWith("video/")

	return (
		<Show
			when={isImage() && src()}
			fallback={
				<Show
					when={isVideo() && src()}
					fallback={
						<a class="chat-msg-file" href={src() || "#"} download={props.name}>
							{props.name}
						</a>
					}
				>
					<div class="chat-msg-video-wrap">
						<video class="chat-msg-video" src={src()!} controls />
					</div>
				</Show>
			}
		>
			<div class="chat-msg-image-wrap" style="width:350px">
				<img class="chat-msg-image" src={src()!} alt={props.name} />
			</div>
		</Show>
	)
}

function DocEmbedView(props: {embed: DocEmbed; msg: ChatMessage; embedIndex: number}) {
	let wrapRef!: HTMLDivElement
	const {handle} = useChat()

	const isPinned = () => {
		const d = handle.doc() as any
		return d?.docs?.some((dl: any) => dl.url === props.embed.docUrl && dl.pin)
	}

	function togglePin() {
		handle.change((d: any) => {
			if (!d.docs) d.docs = []
			const existing = d.docs.find((dl: any) => dl.url === props.embed.docUrl)
			if (existing) {
				if (existing.pin) {
					delete existing.pin
				} else {
					existing.pin = props.embed.toolId || props.embed.type || "default"
				}
			} else {
				d.docs.push({
					url: props.embed.docUrl,
					type: props.embed.type || "unknown",
					name: props.embed.title || "doc",
					pin: props.embed.toolId || props.embed.type || "default",
				})
			}
		})
	}

	onMount(() => {
		if (!wrapRef) return
		const pv = document.createElement("patchwork-view")
		pv.setAttribute("doc-url", props.embed.docUrl)
		if (props.embed.toolId) pv.setAttribute("tool-id", props.embed.toolId)
		wrapRef.appendChild(pv)
	})

	return (
		<div class="chat-msg-embed" style="position:relative">
			<div ref={wrapRef} style="flex:1;min-height:0;display:flex;flex-direction:column" />
			<div class="chat-embed-infobar">
				<Show when={props.embed.title}>
					<span class="chat-msg-embed-title">{props.embed.title}</span>
				</Show>
				<Show when={props.embed.toolId || props.embed.type}>
					<span class="chat-embed-pill">
						<span class="chat-embed-pill-label">tool</span>
						{" " + (props.embed.toolId || props.embed.type || "default")}
					</span>
				</Show>
				<span
					class="chat-embed-pill clickable chat-embed-pin"
					classList={{pinned: isPinned()}}
					title={isPinned() ? "Unpin from sidebar" : "Pin to sidebar"}
					innerHTML={SVG_ICONS.pin}
					on:click={(e) => {
						e.stopPropagation()
						togglePin()
					}}
					on:pointerdown={(e) => e.stopPropagation()}
				/>
			</div>
			<ResizeHandle containerRef={wrapRef} msg={props.msg} sizeKey={"embed_" + props.embedIndex} />
		</div>
	)
}
