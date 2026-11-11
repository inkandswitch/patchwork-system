const NAMED_COLORS: Record<string, {light: string; dark: string}> = {
	red: {light: "oklch(0.55 0.25 25)", dark: "oklch(0.72 0.22 25)"},
	orange: {light: "oklch(0.62 0.22 55)", dark: "oklch(0.78 0.18 55)"},
	yellow: {light: "oklch(0.60 0.20 95)", dark: "oklch(0.88 0.18 95)"},
	green: {light: "oklch(0.50 0.20 145)", dark: "oklch(0.75 0.22 145)"},
	teal: {light: "oklch(0.50 0.14 180)", dark: "oklch(0.75 0.14 180)"},
	cyan: {light: "oklch(0.52 0.15 210)", dark: "oklch(0.80 0.15 210)"},
	blue: {light: "oklch(0.50 0.22 260)", dark: "oklch(0.72 0.18 260)"},
	indigo: {light: "oklch(0.45 0.25 280)", dark: "oklch(0.68 0.20 280)"},
	purple: {light: "oklch(0.50 0.25 300)", dark: "oklch(0.72 0.22 300)"},
	pink: {light: "oklch(0.55 0.25 340)", dark: "oklch(0.75 0.22 340)"},
	hotpink: {light: "oklch(0.55 0.30 350)", dark: "oklch(0.75 0.28 350)"},
	magenta: {light: "oklch(0.52 0.28 320)", dark: "oklch(0.72 0.25 320)"},
	coral: {light: "oklch(0.58 0.20 35)", dark: "oklch(0.78 0.18 35)"},
	gold: {light: "oklch(0.58 0.18 85)", dark: "oklch(0.85 0.16 85)"},
	lime: {light: "oklch(0.52 0.22 130)", dark: "oklch(0.82 0.25 130)"},
	lavender: {light: "oklch(0.50 0.18 290)", dark: "oklch(0.78 0.15 290)"},
	salmon: {light: "oklch(0.55 0.18 25)", dark: "oklch(0.78 0.16 25)"},
	white: {light: "oklch(0.35 0 0)", dark: "oklch(0.95 0 0)"},
	black: {light: "oklch(0.20 0 0)", dark: "oklch(0.60 0 0)"},
	grey: {light: "oklch(0.45 0 0)", dark: "oklch(0.70 0 0)"},
	gray: {light: "oklch(0.45 0 0)", dark: "oklch(0.70 0 0)"},
	neonmint: {light: "oklch(0.85 0.30 160)", dark: "oklch(0.85 0.30 160)"},
}

export function resolveNamedColor(name: string, isLightBg: boolean): string {
	const entry = NAMED_COLORS[name.toLowerCase()]
	if (entry) return isLightBg ? entry.light : entry.dark
	return name
}
