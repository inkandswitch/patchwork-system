/**
 * LLM tools — user-defined tools the model can be given.
 *
 * Each tool is two automerge docs:
 *   - a handler: a real `file` doc (UnixFileEntry, `.js`) holding a block of JS,
 *     editable with the built-in `file` tool (tool-id="file").
 *   - a wrapper `llm:tool` doc: { name, description, handlerUrl } whose URL can
 *     be copied and shared; add a tool to your set by pasting its URL.
 *
 * The tools folder URL lives in the settings doc at `tools` (see config.js).
 */

import {ensureSettingsDoc} from "./config.js"

/**
 * @typedef {import("@automerge/automerge-repo").Repo} Repo
 * @typedef {import("./config.js").LLMConfig} LLMConfig
 * @typedef {import("./config.js").DocHandle} DocHandle
 */

/**
 * @typedef {Object} DocLink
 * @property {string} name
 * @property {string} type
 * @property {string} url
 * @property {string} [icon]
 * @property {string} [copyOf]
 */

/**
 * @typedef {Object} FolderDoc
 * @property {string} [title]
 * @property {DocLink[]} [docs]
 */

/**
 * @typedef {Object} ResolvedTool
 * @property {string} url
 * @property {string} name
 * @property {string} description
 * @property {string} [handlerUrl]
 * @property {any} [parameters]
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} name
 * @property {Record<string, any>} args
 */

/**
 * @typedef {Object} PromptKind
 * @property {string} type
 * @property {string} listKey
 * @property {string} urlKey
 * @property {string} default
 */

/** Sanitize a tool name for OpenAI's function-calling format: [a-zA-Z0-9_-]{1,64}.
 * @param {string} [name]
 */
export function sanitizeToolName(name) {
	return (name || "tool")
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/^[_-]+|[_-]+$/g, "")
		.slice(0, 64) || "tool"
}

const DEFAULT_HANDLER = `// Tool handler. The model calls this tool by name; \`args\` is an object of the
// parameters you describe in the tool's description. Return a string or any
// JSON-serialisable value — it's fed back to the model.
export default async function handle(args) {
\treturn "TODO: implement. got args = " + JSON.stringify(args)
}
`

const DEFAULT_DESCRIPTION =
	"Describe what this tool does, when the model should call it, and the parameters it takes — e.g. { city: string, units?: \"c\" | \"f\" }."

/** @param {Repo} [repo] @returns {Repo} */
function theRepo(repo) {
	return /** @type {Repo} */ (repo || (typeof window !== "undefined" && window.repo) || null)
}

/** @param {string} [name] */
function slug(name) {
	return (name || "tool").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tool"
}

/** Create the handler file doc (a standard `file` doc the file tool can edit).
 * @param {Repo} [repo] @param {string} [name] @param {string} [content]
 */
export async function createToolFile(repo, name = "handler.js", content = DEFAULT_HANDLER) {
	const r = theRepo(repo)
	return r.create2({
		"@patchwork": {type: "file"},
		name,
		extension: "js",
		mimeType: "text/javascript",
		content,
	})
}

/** Create a new llm-tool (handler file + wrapper doc). Returns the wrapper handle.
 * @param {Repo} [repo] @param {{name?: string, description?: string}} [opts]
 */
export async function createLLMTool(repo, {name = "New tool", description = DEFAULT_DESCRIPTION} = {}) {
	const r = theRepo(repo)
	const file = await createToolFile(r, slug(name) + ".js")
	return r.create2({
		"@patchwork": {type: "llm:tool"},
		name,
		description,
		tool: file.url, // the handler file
	})
}

// ---------------------------------------------------------------------------
// Folders — tools + prompts each live in a `folder` doc (so they're openable /
// manageable as a normal Patchwork folder). cfg.tools / cfg.prompts are the
// folder URLs; the folder's `.docs` are the DocLinks.
// ---------------------------------------------------------------------------

/** Read a folder's DocLinks, optionally filtered by `.type`.
 * @param {string|null|undefined} folderUrl @param {string} [type] @param {Repo} [repo]
 * @returns {Promise<DocLink[]>}
 */
export async function folderLinks(folderUrl, type, repo) {
	if (typeof folderUrl !== "string") return []
	try {
		const folder = /** @type {FolderDoc} */ ((await theRepo(repo).find(/** @type {any} */ (folderUrl))).doc())
		const docs = folder?.docs || []
		return type ? docs.filter((l) => l.type === type) : docs
	} catch {
		return []
	}
}

/** Ensure a folder URL exists; create an empty `folder` doc if missing. Returns the URL.
 * @param {Repo} [repo] @param {string|null|undefined} [url] @param {string} [title]
 */
export async function ensureFolderUrl(repo, url, title = "Folder") {
	if (typeof url === "string") return url
	return (
		await theRepo(repo).create2({"@patchwork": {type: "folder"}, title, docs: []})
	).url
}

/** @param {Repo} repo @param {string} folderUrl @param {DocLink} docLink */
export async function addToFolder(repo, folderUrl, docLink) {
	const h = await theRepo(repo).find(/** @type {any} */ (folderUrl))
	h.change((/** @type {FolderDoc} */ d) => {
		if (!d.docs) d.docs = []
		d.docs.push(docLink)
	})
}

/** @param {Repo} repo @param {string} folderUrl @param {string} docUrl */
export async function removeFromFolder(repo, folderUrl, docUrl) {
	const h = await theRepo(repo).find(/** @type {any} */ (folderUrl))
	h.change((/** @type {FolderDoc} */ d) => {
		if (!d.docs) return
		const i = d.docs.findIndex((l) => l.url === docUrl)
		if (i !== -1) d.docs.splice(i, 1)
	})
}

/** Resolve the tools folder into [{ url, name, description, handlerUrl }].
 * @param {LLMConfig} [cfg] @param {Repo} [repo] @returns {Promise<ResolvedTool[]>}
 */
export async function resolveTools(cfg, repo) {
	const r = theRepo(repo)
	const links = await folderLinks(cfg?.tools, "llm:tool", repo)
	/** @type {ResolvedTool[]} */
	const out = []
	for (const link of links) {
		try {
			const d = /** @type {any} */ ((await r.find(/** @type {any} */ (link.url))).doc())
			if (d)
				out.push({
					url: link.url,
					name: d.name || link.name || "Tool",
					description: d.description || "",
					handlerUrl: d.tool ?? d.handlerUrl, // `tool`, or legacy `handlerUrl`
					// Folder tools carry no JSON Schema — permissive params; the model
					// learns the shape from the description.
					parameters: d.parameters || {type: "object", additionalProperties: true},
				})
		} catch {
			/* unreachable — skip */
		}
	}
	return out
}

/** OpenAI-style tool schemas, for providers with native function calling.
 * @param {ResolvedTool[]} [tools]
 */
export function toToolSchemas(tools) {
	return (tools || []).map((t) => ({
		type: "function",
		function: {
			name: sanitizeToolName(t.name),
			description: t.description || "",
			parameters: t.parameters || {type: "object", properties: {}, additionalProperties: true},
		},
	}))
}

/**
 * System-prompt block for providers WITHOUT native tool calling (local
 * transformers, Chrome built-in). Uses the Hermes/Qwen `<tool_call>` XML
 * convention — what those models are tuned to emit.
 */
/** @param {ResolvedTool[]} [tools] */
export function buildToolsSystem(tools) {
	if (!tools || !tools.length) return ""
	const describe = (/** @type {ResolvedTool} */ t) => {
		const props = t.parameters?.properties
		const params =
			props && Object.keys(props).length
				? " — args: " +
					Object.entries(props)
						.map(([k, v]) => `${k}${v?.type ? ":" + v.type : ""}`)
						.join(", ")
				: ""
		return `- ${sanitizeToolName(t.name)}: ${t.description || ""}${params}`
	}
	return [
		"You can call tools. To call one, emit a tool call wrapped in <tool_call></tool_call> tags containing JSON, exactly:",
		'<tool_call>{"name": "<tool>", "arguments": { ... }}</tool_call>',
		"You'll then be given the tool's result and can call another tool or answer. Call a tool only when it genuinely helps — otherwise just answer in plain prose.",
		"",
		"Available tools:",
		tools.map(describe).join("\n"),
	].join("\n")
}

/**
 * Parse tool calls out of model TEXT (the prompt-convention fallback for
 * local/built-in). Handles, in order of preference:
 *   - <tool_call>{…}</tool_call>  (Hermes/Qwen XML)
 *   - ```json / ```tool_call / ```tool-call  fenced JSON
 *   - a bare {…} object containing a name/tool key
 * Each accepts {name|tool, arguments|args}. Returns [{ name, args }].
 */
/** @param {string} [text] @returns {ToolCall[]} */
export function parseToolCalls(text) {
	if (!text) return []
	/** @type {ToolCall[]} */
	const calls = []
	const push = (/** @type {any} */ obj) => {
		const name = obj?.name || obj?.tool
		if (!name) return
		let args = obj.arguments ?? obj.args ?? {}
		if (typeof args === "string") {
			try {
				args = JSON.parse(args)
			} catch {
				args = {}
			}
		}
		calls.push({name, args: args || {}})
	}
	const thinkingEnd = text.lastIndexOf("</think>")
	const lfmRegionStart = thinkingEnd === -1 ? 0 : thinkingEnd + "</think>".length
	const lfmMatch = text
		.slice(lfmRegionStart)
		.search(/\[\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(/)
	const lfmStart = lfmMatch === -1 ? -1 : lfmRegionStart + lfmMatch
	if (lfmStart !== -1) {
		let depth = 0
		let quote = ""
		let escaped = false
		let lfmEnd = -1
		for (let i = lfmStart; i < text.length; i++) {
			const ch = text[i]
			if (escaped) {
				escaped = false
				continue
			}
			if (quote) {
				if (ch === "\\") escaped = true
				else if (ch === quote) quote = ""
				continue
			}
			if (ch === "'" || ch === '"') {
				quote = ch
				continue
			}
			if (ch === "[" || ch === "(" || ch === "{") depth++
			else if (ch === "]" || ch === ")" || ch === "}") {
				depth--
				if (depth === 0) {
					lfmEnd = i
					break
				}
			}
		}
		if (lfmEnd !== -1) {
			const split = (source = "") => {
				const parts = []
				let start = 0
				let nested = 0
				let string = ""
				let slash = false
				for (let i = 0; i < source.length; i++) {
					const ch = source[i]
					if (slash) {
						slash = false
						continue
					}
					if (string) {
						if (ch === "\\") slash = true
						else if (ch === string) string = ""
						continue
					}
					if (ch === "'" || ch === '"') string = ch
					else if (ch === "[" || ch === "(" || ch === "{") nested++
					else if (ch === "]" || ch === ")" || ch === "}") nested--
					else if (ch === "," && nested === 0) {
						parts.push(source.slice(start, i).trim())
						start = i + 1
					}
				}
				const last = source.slice(start).trim()
				if (last) parts.push(last)
				return parts
			}
			const literal = (source = "") => {
				let json = ""
				for (let i = 0; i < source.length; i++) {
					const ch = source[i]
					if (ch !== "'" && ch !== '"') {
						json += ch
						continue
					}
					let value = ""
					for (i++; i < source.length; i++) {
						const next = source[i]
						if (next === ch) break
						if (next !== "\\") {
							value += next
							continue
						}
						const escaped = source[++i]
						value +=
							escaped === "n"
								? "\n"
								: escaped === "r"
									? "\r"
									: escaped === "t"
										? "\t"
										: escaped
					}
					json += JSON.stringify(value)
				}
				try {
					return JSON.parse(
						json.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null")
					)
				} catch {
					return source
				}
			}
			for (const expression of split(text.slice(lfmStart + 1, lfmEnd))) {
				const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)$/.exec(expression)
				if (!match) continue
				const args = Object.fromEntries([])
				for (const arg of split(match[2])) {
					const eq = arg.indexOf("=")
					if (eq < 1) continue
					const name = arg.slice(0, eq).trim()
					if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue
					args[name] = literal(arg.slice(eq + 1).trim())
				}
				calls.push({name: match[1], args})
			}
			if (calls.length) return calls
		}
	}
	let m
	const xml = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
	let sawXml = false
	while ((m = xml.exec(text))) {
		sawXml = true
		try {
			push(JSON.parse(m[1].trim()))
		} catch {}
	}
	if (sawXml) return calls
	const fence = /```(?:json|tool[_-]call)?\s*([\s\S]*?)```/g
	while ((m = fence.exec(text))) {
		try {
			push(JSON.parse(m[1].trim()))
		} catch {}
	}
	if (calls.length) return calls
	// Bare JSON objects — brace-depth-aware scan so nested objects (e.g.
	// "arguments": { ... }) are captured whole instead of truncated at the
	// first inner `}`.
	let depth = 0, start = -1, inStr = false, esc = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (esc) { esc = false; continue }
		if (ch === '\\' && inStr) { esc = true; continue }
		if (ch === '"') { inStr = !inStr; continue }
		if (inStr) continue
		if (ch === '{') {
			if (depth === 0) start = i
			depth++
		} else if (ch === '}') {
			depth--
			if (depth === 0 && start >= 0) {
				const block = text.slice(start, i + 1)
				if (/"(?:name|tool)"/.test(block)) {
					try { push(JSON.parse(block)) } catch {}
				}
				start = -1
			}
		}
	}
	return calls
}

/** Fetch a handler file doc's JS source as a string.
 * @param {string} handlerUrl @param {Repo} [repo]
 */
async function loadHandlerCode(handlerUrl, repo) {
	const h = await theRepo(repo).find(/** @type {any} */ (handlerUrl))
	const content = /** @type {any} */ (h.doc())?.content
	return typeof content === "string"
		? content
		: new TextDecoder().decode(content || new Uint8Array())
}

/**
 * Load a tool's handler as a function. The handler file's JS is imported as an
 * ES module (via a blob URL) and runs in the MAIN thread with full page access
 * (window.repo, the account doc, the DOM). Use a sandbox (see runTool) for
 * untrusted / shared tools that shouldn't have that reach.
 * @param {string} handlerUrl @param {Repo} [repo]
 */
export async function loadHandler(handlerUrl, repo) {
	const code = await loadHandlerCode(handlerUrl, repo)
	const blobUrl = URL.createObjectURL(new Blob([code], {type: "text/javascript"}))
	try {
		const mod = await import(/* @vite-ignore */ blobUrl)
		const fn = mod.default || mod.handle
		if (typeof fn !== "function")
			throw new Error("tool handler must `export default` a function")
		return fn
	} finally {
		URL.revokeObjectURL(blobUrl)
	}
}

// A module worker that imports the handler code in its OWN realm and runs it on
// just the args we hand in — no window, no DOM, no window.repo, no account doc,
// no network of ours. Only structured-cloneable args/results cross the boundary.
const SANDBOX_BOOTSTRAP = `
self.onmessage = async (e) => {
	const {code, args} = e.data
	let url
	try {
		url = URL.createObjectURL(new Blob([code], {type: "text/javascript"}))
		const mod = await import(url)
		const fn = mod.default || mod.handle
		if (typeof fn !== "function") throw new Error("tool handler must export default a function")
		const result = await fn(args || {})
		self.postMessage({ok: true, result})
	} catch (err) {
		self.postMessage({ok: false, error: (err && err.message) || String(err)})
	} finally {
		if (url) URL.revokeObjectURL(url)
	}
}
`

/**
 * Run handler `code` in an isolated Worker — no page access. A runaway handler
 * is killed after `timeoutMs` (default 10s). Throws on handler error/timeout.
 * @param {string} code @param {any} args @param {{timeoutMs?: number}} [opts]
 */
export async function runHandlerSandboxed(code, args, {timeoutMs = 10000} = {}) {
	const bootUrl = URL.createObjectURL(new Blob([SANDBOX_BOOTSTRAP], {type: "text/javascript"}))
	const worker = new Worker(bootUrl, {type: "module"})
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("tool handler timed out")), timeoutMs)
			worker.onmessage = (e) => {
				clearTimeout(timer)
				if (e.data?.ok) resolve(e.data.result)
				else reject(new Error(e.data?.error || "tool handler failed"))
			}
			worker.onerror = (e) => {
				clearTimeout(timer)
				reject(new Error(e.message || "tool handler worker error"))
			}
			worker.postMessage({code, args: args || {}})
		})
	} finally {
		worker.terminate()
		URL.revokeObjectURL(bootUrl)
	}
}

/**
 * Run a resolved tool with args. By default loads + calls its handler in the
 * MAIN thread (full page access). Pass `{sandbox: true}` to run it in an
 * isolated Worker with no page access — for untrusted / shared tools.
 *
 * @param {ResolvedTool} tool   resolved tool ({handlerUrl, …})
 * @param {any} args
 * @param {any} [opts]  options, or a Repo (back-compat positional repo)
 */
export async function runTool(tool, args, opts = {}) {
	// Back-compat: runTool(tool, args, repo) — a Repo has a `.find` method.
	const o = opts && typeof opts.find === "function" ? {repo: opts} : opts || {}
	if (o.sandbox) {
		const code = await loadHandlerCode(/** @type {string} */ (tool.handlerUrl), o.repo)
		return runHandlerSandboxed(code, args, {timeoutMs: o.timeoutMs})
	}
	const fn = await loadHandler(/** @type {string} */ (tool.handlerUrl), o.repo)
	return fn(args || {})
}

/** Datatype so an `llm:tool` doc has a title/icon and can be opened. */
export const LLMToolDatatype = {
	/** @param {any} doc */
	init(doc) {
		doc["@patchwork"] = {type: "llm:tool"}
		doc.name = "New tool"
		doc.description = DEFAULT_DESCRIPTION
	},
	/** @param {any} doc */
	getTitle(doc) {
		return doc.name || "LLM tool"
	},
	/** @param {any} doc @param {string} title */
	setTitle(doc, title) {
		doc.name = title
	},
	/** @param {any} doc */
	markCopy(doc) {
		doc.name = "Copy of " + (doc.name || "tool")
	},
}

// ---------------------------------------------------------------------------
// Saved prompts (system + pre) — same shape as tools: the prompt TEXT lives in a
// real `file` (.txt) doc you edit with the file tool, wrapped in an
// `llm:system-prompt` / `llm:pre-prompt` doc whose URL can be copied/shared.
// Libraries live at `llm.systemPrompts` / `llm.prePrompts`; the chosen one at
// `llm.prompts.systemUrl` / `llm.prompts.preUrl`.
// ---------------------------------------------------------------------------

/** @type {Record<string, PromptKind>} */
const PROMPT_KINDS = {
	system: {type: "llm:system-prompt", listKey: "systemPrompts", urlKey: "systemUrl", default: "LLMs are a computer program. They should respond like a computer program."},
	pre: {type: "llm:pre-prompt", listKey: "prePrompts", urlKey: "preUrl", default: "Genre: noir detective."},
}

/** Create a saved prompt (text file + wrapper). `kind` = "system" | "pre".
 * @param {Repo} [repo] @param {string} [kind] @param {{name?: string, text?: string}} [opts]
 */
export async function createPromptDoc(repo, kind, {name, text} = {}) {
	const r = theRepo(repo)
	const k = PROMPT_KINDS[/** @type {string} */ (kind)] || PROMPT_KINDS.system
	const file = await r.create2({
		"@patchwork": {type: "file"},
		name: slug(name || kind) + ".txt",
		extension: "txt",
		mimeType: "text/plain",
		content: text ?? k.default,
	})
	return r.create2({
		"@patchwork": {type: k.type},
		name: name || "New prompt",
		promptUrl: file.url,
	})
}

/** Resolve the prompts folder (filtered by `kind`) into [{ url, name, promptUrl }].
 * @param {LLMConfig} [cfg] @param {string} [kind] @param {Repo} [repo]
 */
export async function resolvePromptDocs(cfg, kind, repo) {
	const k = PROMPT_KINDS[/** @type {string} */ (kind)] || PROMPT_KINDS.system
	const r = theRepo(repo)
	const links = await folderLinks(cfg?.prompts, k.type, repo)
	/** @type {{url: string, name: string, promptUrl: any}[]} */
	const out = []
	for (const link of links) {
		try {
			const d = /** @type {any} */ ((await r.find(/** @type {any} */ (link.url))).doc())
			out.push({url: link.url, name: d?.name || link.name || "Prompt", promptUrl: d?.promptUrl})
		} catch {
			/* unreachable — skip */
		}
	}
	return out
}

/** Read the text of the currently-selected prompt for `kind` (its file content).
 * @param {LLMConfig} [cfg] @param {string} [kind] @param {Repo} [repo]
 */
export async function resolvePromptText(cfg, kind, repo) {
	const k = PROMPT_KINDS[/** @type {string} */ (kind)] || PROMPT_KINDS.system
	const url = /** @type {any} */ (cfg)?.[k.urlKey] // top-level systemUrl / preUrl
	if (!url) return ""
	const r = theRepo(repo)
	try {
		const promptUrl = /** @type {any} */ ((await r.find(url)).doc())?.promptUrl
		if (!promptUrl) return ""
		const content = /** @type {any} */ ((await r.find(promptUrl)).doc())?.content
		return typeof content === "string"
			? content
			: new TextDecoder().decode(content || new Uint8Array())
	} catch {
		return ""
	}
}

/** Resolve a cfg's selected system + pre prompt docs into `cfg.resolved.{system,pre}` text.
 * @param {LLMConfig} [cfg] @param {Repo} [repo]
 */
export async function resolveCfgPrompts(cfg, repo) {
	const system = await resolvePromptText(cfg, "system", repo)
	const pre = await resolvePromptText(cfg, "pre", repo)
	return {...cfg, resolved: {system, pre}}
}

/**
 * One-time migration. Converts the legacy `tools` (URL array),
 * `systemPrompts`/`prePrompts` (URL arrays) and `prompts` (object) inside the
 * settings doc (see `ensureSettingsDoc`) into `folder` docs + the new scalar
 * shape. Idempotent.
 * @param {Repo} [repo]
 */
export async function migrateConfig(repo) {
	const r = theRepo(repo)
	const handle = await ensureSettingsDoc()
	if (!r || !handle) return
	const llm = /** @type {any} */ (handle.doc() ?? {})
	const oldTools = Array.isArray(llm.tools) ? llm.tools : null
	const oldPromptsObj = llm.prompts && typeof llm.prompts === "object" ? llm.prompts : null
	const oldSys = Array.isArray(llm.systemPrompts) ? llm.systemPrompts : []
	const oldPre = Array.isArray(llm.prePrompts) ? llm.prePrompts : []
	const needsPrompts =
		!!oldPromptsObj || oldSys.length || oldPre.length || "systemPrompts" in llm || "prePrompts" in llm
	if (!oldTools && !needsPrompts) return // already migrated

	const linkFor = async (/** @type {any} */ url, /** @type {string} */ type, /** @type {string} */ fallback) => {
		try {
			return {name: /** @type {any} */ ((await r.find(url)).doc())?.name || fallback, type, url}
		} catch {
			return {name: fallback, type, url}
		}
	}
	/** @type {string|undefined} */
	let toolsFolder
	/** @type {string|undefined} */
	let promptsFolder
	if (oldTools) {
		const links = await Promise.all(oldTools.map((/** @type {any} */ u) => linkFor(u, "llm:tool", "Tool")))
		toolsFolder = (
			await r.create2({"@patchwork": {type: "folder"}, title: "LLM Tools", docs: links})
		).url
	}
	if (needsPrompts) {
		const sysLinks = await Promise.all(oldSys.map((/** @type {any} */ u) => linkFor(u, "llm:system-prompt", "System prompt")))
		const preLinks = await Promise.all(oldPre.map((/** @type {any} */ u) => linkFor(u, "llm:pre-prompt", "Pre-prompt")))
		promptsFolder = (
			await r.create2({
				"@patchwork": {type: "folder"},
				title: "LLM Prompts",
				docs: [...sysLinks, ...preLinks],
			})
		).url
	}
	handle.change((/** @type {any} */ d) => {
		// `d` is the settings-doc body (the config itself).
		if (toolsFolder) {
			delete d.tools
			d.tools = toolsFolder
		}
		if (needsPrompts) {
			if (oldPromptsObj?.systemUrl && !d.systemUrl) d.systemUrl = oldPromptsObj.systemUrl
			if (oldPromptsObj?.preUrl && !d.preUrl) d.preUrl = oldPromptsObj.preUrl
			delete d.prompts
			d.prompts = promptsFolder
		}
		delete d.systemPrompts
		delete d.prePrompts
	})
}

/** @param {string} kind */
function promptDatatype(kind) {
	const k = PROMPT_KINDS[kind]
	return {
		/** @param {any} doc */
		init(doc) {
			doc["@patchwork"] = {type: k.type}
			doc.name = "New prompt"
		},
		/** @param {any} doc */
		getTitle(doc) {
			return doc.name || "Prompt"
		},
		/** @param {any} doc @param {string} title */
		setTitle(doc, title) {
			doc.name = title
		},
		/** @param {any} doc */
		markCopy(doc) {
			doc.name = "Copy of " + (doc.name || "prompt")
		},
	}
}

/** Datatypes so the wrapper docs have a title/icon. */
export const LLMSystemPromptDatatype = promptDatatype("system")
export const LLMPrePromptDatatype = promptDatatype("pre")
