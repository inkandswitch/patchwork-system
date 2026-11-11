let notificationAudio: HTMLAudioElement | null = null

export async function getNotificationSound(): Promise<HTMLAudioElement | null> {
	if (notificationAudio) return notificationAudio
	try {
		const resp = await fetch(new URL("../../3beep.mp3", import.meta.url))
		const blob = await resp.blob()
		notificationAudio = new Audio(URL.createObjectURL(blob))
		notificationAudio.volume = 0.5
		return notificationAudio
	} catch (e) {
		console.warn("[Chat] notification sound:", e)
		return null
	}
}

export function showOSNotification(
	authorName: string,
	text: string,
	avatarBlobUrl?: string,
	chatUrl?: string
) {
	if (typeof Notification === "undefined") return
	if (Notification.permission !== "granted") return
	try {
		const n = new Notification("New message from " + authorName, {
			body: (text || "").slice(0, 200),
			icon: avatarBlobUrl || undefined,
			tag: chatUrl,
		})
		n.onclick = () => {
			window.focus()
			n.close()
		}
	} catch (e) {
		console.warn("[Chat] notification:", e)
	}
}

let originalFaviconHref: string | null = null
let faviconWithDot: string | null = null

export function setFaviconUnread(unread: boolean) {
	let link =
		document.querySelector<HTMLLinkElement>('link[rel="icon"]') ||
		document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]')
	if (!link) {
		link = document.createElement("link")
		link.rel = "icon"
		document.head.appendChild(link)
	}
	if (!originalFaviconHref && link.href) originalFaviconHref = link.href

	if (!unread) {
		if (originalFaviconHref) link.href = originalFaviconHref
		faviconWithDot = null
		return
	}
	if (faviconWithDot) {
		link.href = faviconWithDot
		return
	}

	const size = 64
	const canvas = document.createElement("canvas")
	canvas.width = size
	canvas.height = size
	const ctx = canvas.getContext("2d")!

	function drawDot() {
		ctx.beginPath()
		ctx.arc(size - 10, 10, 10, 0, Math.PI * 2)
		ctx.fillStyle = "#ed4245"
		ctx.fill()
		faviconWithDot = canvas.toDataURL("image/png")
		link!.href = faviconWithDot!
	}

	if (originalFaviconHref) {
		const img = new Image()
		img.crossOrigin = "anonymous"
		img.onload = () => {
			ctx.drawImage(img, 0, 0, size, size)
			drawDot()
		}
		img.onerror = () => drawDot()
		img.src = originalFaviconHref
	} else {
		drawDot()
	}
}
