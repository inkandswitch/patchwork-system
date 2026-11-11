export function generateId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	})
}

export function formatTimeGap(ts: number): string {
	const d = new Date(ts)
	const now = new Date()
	const isToday = d.toDateString() === now.toDateString()
	if (isToday) {
		return d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})
	}
	return d.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

export function formatDuration(s: number): string {
	const m = Math.floor(s / 60)
	return (
		m +
		":" +
		Math.floor(s % 60)
			.toString()
			.padStart(2, "0")
	)
}
