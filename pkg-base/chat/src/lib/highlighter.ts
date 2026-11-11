let highlighterPromise: Promise<any> | null = null
let highlighter: any = null

async function getHighlighter() {
	if (highlighter) return highlighter
	if (!highlighterPromise) {
		highlighterPromise = (async () => {
			try {
				const shiki = await import("https://esm.sh/shiki@3.2.1/bundle/web" as any)
				highlighter = await shiki.createHighlighter({
					themes: ["github-dark", "github-light"],
					langs: ["javascript", "typescript", "json", "html", "css", "yaml", "python", "markdown"],
				})
				return highlighter
			} catch (e) {
				console.warn("[Chat] shiki load failed:", e)
				return null
			}
		})()
	}
	return highlighterPromise
}

// Map custom fence types to real shiki language IDs
const LANG_ALIASES: Record<string, string> = {
	"patchwork-tool": "javascript",
	"tool-call": "yaml",
}

export async function highlightCode(code: string, lang?: string, isLight?: boolean): Promise<string> {
	const hl = await getHighlighter()
	if (!hl) return escapeHtml(code)

	const resolvedLang = LANG_ALIASES[lang || ""] || lang || "javascript"
	const supportedLangs = hl.getLoadedLanguages?.() || []
	if (!supportedLangs.includes(resolvedLang)) {
		try {
			await hl.loadLanguage(resolvedLang)
		} catch {
			return escapeHtml(code)
		}
	}

	const theme = isLight ? "github-light" : "github-dark"
	try {
		return hl.codeToHtml(code, {lang: resolvedLang, theme})
	} catch {
		return "<pre><code>" + escapeHtml(code) + "</code></pre>"
	}
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
}
