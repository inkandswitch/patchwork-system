import {createSignal, createMemo, createEffect, Show, onMount, onCleanup} from "solid-js"
import type {DocHandle, AutomergeUrl} from "@automerge/automerge-repo/slim"
import {updateText, splice} from "@automerge/automerge/slim"
import {applyAutomerge} from "../lib/automerge-ops"
import type {ChatDoc} from "../types"
import type {FeatureSelector} from "../features"
import {featurePlugins} from "../features"
import {createLoadedPlugins} from "../lib/slots"
import {expandSelector, docSelector} from "../lib/plugin-catalog"
import type {PluginSelector} from "../lib/registry"
import {ChatProvider, useChat} from "../context/ChatContext"
import {IdentityProvider, useIdentity} from "../context/IdentityContext"
import {ThemeProvider} from "../context/ThemeContext"
import {PresenceProvider, usePresence} from "../context/PresenceContext"
import {SlotProvider, Slot, type SlotBaseCaps} from "../context/SlotContext"
import {PresenceBar} from "./PresenceBar"
import {MessageList} from "./MessageList"
import {TypingBar} from "./TypingBar"
import {InputArea} from "./InputArea"
import {PluginPanel} from "./PluginPanel"
import {Lightbox} from "./Lightbox"
// The LLM client is looked up at runtime from whichever package registers a
// `patchwork:worker-client` plugin with id "llm" (llm-host, for now), so chat
// has no build-time dependency on it. See "The paired client plugin" in
// libraries/patchwork-worker/README.md.
import {connectWorkerClient} from "@grjte/patchwork-worker/client.js"
import {generateId} from "../lib/helpers"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"
import {transcribeVoiceNote} from "../lib/transcription"
import {reloadPreviewIframe} from "../lib/preview-frame"
import "../styles/chat.css"

function clog(...args: any[]) {
	try {
		console.log("[chat-llm]", ...args)
	} catch {}
}

/** The LLM client API the "llm" worker-client factory returns (llm-host/src/client.js). */
interface LLMClient {
	generate(
		messages: any[] | string,
		opts?: Record<string, any>
	): Promise<{text: string; toolCalls: any[] | null; toolMode?: string}>
}

// One client for the whole tool, made on first use. A failed lookup isn't
// cached, so if chat asks before llm-host has registered, the next generation
// tries again.
let llmClientPromise: Promise<LLMClient> | null = null
function llmClient(): Promise<LLMClient> {
	if (!llmClientPromise) {
		llmClientPromise = connectWorkerClient("llm", {
			sessionOpts: {idPrefix: "chatllm", onLog: clog},
		}) as Promise<LLMClient>
		llmClientPromise.catch(() => {
			llmClientPromise = null
		})
	}
	return llmClientPromise
}

export function ChatRoot(props: {
	handle: DocHandle<ChatDoc>
	element: HTMLElement
	// "context" mode (the `context-tool` variant): no sidebar, and the computer
	// edits a *focused* document instead of building tools. targetDocUrl is the
	// currently-selected doc the computer reads/writes.
	mode?: "chat" | "context"
	targetDocUrl?: () => AutomergeUrl | undefined
	// Optional selector OVERRIDE (the embeddable component's `features=` attr).
	// When absent, the active feature set is driven by the document's `plugins`
	// array — the same source ChatProvider reads.
	selector?: FeatureSelector
}) {
	let rootRef!: HTMLDivElement
	// Active features resolved locally too (the Computer engine onMounts run
	// outside the ChatProvider, so they can't read hasFeature from context). This
	// mirrors ChatProvider: override wins, else the doc's `plugins` array, and it
	// stays reactive so `/plugin` toggles UI live.
	const [docSel, setDocSel] = createSignal<PluginSelector>(
		docSelector(props.handle.doc() as any)
	)
	const onPluginsChange = () =>
		setDocSel(() => docSelector(props.handle.doc() as any))
	props.handle.on("change", onPluginsChange)
	onCleanup(() => props.handle.off("change", onPluginsChange))
	const activeFeatures = createMemo(() =>
		expandSelector(props.selector ?? docSel())
	)
	const has = (id: string) => activeFeatures().has(id)

	// Active feature plugins with their loaded module flattened on (`.slots`,
	// `.buildContext`, …). Lets the host stay feature-agnostic: it discovers what a
	// feature contributes (a presence-bar button, extra LLM context) rather than
	// naming specific ones. Cross-bundle features (e.g. `call`) load via the registry.
	const loadedFeatures = createLoadedPlugins(
		"chat:feature",
		featurePlugins,
		() => [...activeFeatures()]
	)
	// Does any active feature contribute the given render slot? (Drives chrome
	// visibility without the host hardcoding which feature owns which slot.)
	const hasSlot = (slot: string) =>
		loadedFeatures().some((f: any) => f?.slots && slot in f.slots)

	// Are we the streamlined doc-editing "context tool"?
	const isContext = () => props.mode === "context"

	// Emoji picker state
	const [emojiPickerState, setEmojiPickerState] = createSignal<{
		open: boolean
		targetIdx: number | null
		anchorEl: HTMLElement | null
	}>({open: false, targetIdx: null, anchorEl: null})

	// Reply state
	const [replyToId, setReplyToId] = createSignal<string | null>(null)

	// Dialog state
	const [showEmoticonDialog, setShowEmoticonDialog] = createSignal(false)
	const [showFontDialog, setShowFontDialog] = createSignal(false)
	const [showPluginPanel, setShowPluginPanel] = createSignal(false)

	// Sidebar state
	const [sidebarVisible, setSidebarVisible] = createSignal(false)

	// What the host looks up LLM config for. `docName` is only a label for the
	// picker.
	const llmScope = () => ({
		toolId: "chitterchatter",
		docId: props.handle.url,
		toolName: "Chitterchatter",
		docName: (props.handle.doc() as any)?.title || "this chat",
	})

	// Ask the host to open the LLM config tray (relayed by the open-tool bridge
	// when chat is isolated). Our prompt and tools go along for it to show.
	function openModelPicker() {
		props.element.dispatchEvent(
			new CustomEvent("patchwork:open-tool", {
				detail: {
					component: "llm-config-tray",
					scope: llmScope(),
					toolPrompt: {
						name: "Chitterchatter · Computer",
						text: computerSystemPrompt(),
					},
					toolTools: activeTools().map((t) => ({
						name: t.name,
						description: t.description,
						defaultOff: GLOBAL_DEFAULT_OFF.includes(t.name) || CONTEXT_DEFAULT_OFF.includes(t.name),
					})),
				},
				bubbles: true,
				composed: true,
			})
		)
	}

	// Drop state
	const [showDropOverlay, setShowDropOverlay] = createSignal(false)
	const [pendingFiles, setPendingFiles] = createSignal<
		{blob: Blob; dataUrl?: string; name: string; mimeType: string}[]
	>([])
	const [pendingEmbeds, setPendingEmbeds] = createSignal<
		{url: string; toolId?: string; name?: string; type?: string}[]
	>([])
	let dragCounter = 0

	// Computer/LLM state
	const [computerActive, setComputerActive] = createSignal(false)
	const [computerAutoMode, setComputerAutoMode] = createSignal(false)
	const [llmStatus, setLlmStatus] = createSignal("")
	// Human-readable label of the model the computer is currently running, shown
	// in the computer's username (e.g. "computer (OpenRouter Claude Opus 4)").
	const [modelLabel, setModelLabel] = createSignal("")
	// Called with the model label the worker sends with each generation.
	function noteModelLabel(label: string) {
		if (!label) return
		const before = modelLabel()
		setModelLabel(label)
		if (before && label !== before) {
			sendComputerMessage("🔌 switched model to " + label)
		}
	}
	// The model name suffix shown after the computer's username, e.g. " (Browser
	// Qwen3 0.6B)". Empty until the label resolves.
	function modelSuffix() {
		const label = modelLabel()
		return label ? " (" + label + ")" : ""
	}
	// The computer's display name: includes who OWNS it (the host) when claimed,
	// then the current model label when known — e.g. "computer (chee) (Opus 4)".
	function computerName() {
		const owner = (props.handle.doc() as any)?.computerOwner
		return "computer" + (owner ? " (" + owner + ")" : "") + modelSuffix()
	}
	const [computerAbort, setComputerAbort] =
		createSignal<AbortController | null>(null)
	const computerRespondedToIds = new Set<string>()
	let computerResponding = false
	let computerListenerActive = false
	let computerListenerCleanup: (() => void) | null = null
	// Single-host: only one tab should respond as Computer
	const myInstanceId = generateId()
	let heartbeatInterval: any = null
	let stalenessWatchInterval: any = null
	const HEARTBEAT_INTERVAL = 15000
	const STALE_THRESHOLD = 45000 // 3 missed heartbeats = stale
	const PING_TIMEOUT = 2000 // wait 2s for pong before claiming
	const RESPONSE_TIMEOUT = 8000 // wait 8s for computer to start responding

	// The human name of whoever currently OWNS (hosts) the computer. Stored on the
	// doc as `computerOwner`, shown in the computer's display name, and surfaced /
	// changed via /computer owner|own|pwn. ownerName() is THIS user's name.
	const [ownerName, setOwnerName] = createSignal<string>("")
	onMount(async () => {
		try {
			const ad = (window as any).accountDocHandle
			const contactUrl = ad?.doc?.()?.contactUrl
			if (!contactUrl) return
			const contact = await (props.element as any).repo.find(contactUrl)
			const n = (contact.doc() as any)?.name
			if (n) setOwnerName(n)
		} catch {}
	})
	// If this tab is the host, keep the doc's `computerOwner` (our name) and
	// `computerModel` (the model label) up to date so everyone — including the
	// avatar tooltip and the computer's display name — can see who's running it
	// and with what model. Runs when our name or the model label resolves/changes.
	createEffect(() => {
		const n = ownerName()
		const m = modelLabel()
		const d = props.handle.doc() as any
		if (d?.computerInstanceId !== myInstanceId) return
		const needOwner = !!n && d?.computerOwner !== n
		const needModel = !!m && d?.computerModel !== m
		if (needOwner || needModel) {
			props.handle.change((dd: any) => {
				if (needOwner) dd.computerOwner = n
				if (needModel) dd.computerModel = m
			})
		}
	})

	function openEmojiPicker(idx: number, anchorEl: HTMLElement) {
		setEmojiPickerState({open: true, targetIdx: idx, anchorEl})
	}

	function closeEmojiPicker() {
		setEmojiPickerState({open: false, targetIdx: null, anchorEl: null})
	}

	function toggleSidebar() {
		setSidebarVisible(!sidebarVisible())
	}

	// Close modals on Escape
	function handleKeyDown(e: KeyboardEvent) {
		if (e.key !== "Escape") return
		if (lightboxSrc()) {
			setLightboxSrc(null)
			return
		}
		if (emojiPickerState().open) {
			closeEmojiPicker()
			return
		}
		if (showEmoticonDialog()) {
			setShowEmoticonDialog(false)
			return
		}
		if (showFontDialog()) {
			setShowFontDialog(false)
			return
		}
	}
	onMount(() => document.addEventListener("keydown", handleKeyDown))
	onCleanup(() => document.removeEventListener("keydown", handleKeyDown))

	// ---- Computer / LLM ----
	const TOOL_ADJECTIVES = [
		"tiny",
		"sparkly",
		"cozy",
		"fuzzy",
		"wiggly",
		"bouncy",
		"snappy",
		"zippy",
		"dizzy",
		"poppy",
		"bubbly",
		"chirpy",
		"jolly",
		"perky",
		"zappy",
		"scruffy",
	]
	const TOOL_NOUNS = [
		"kitten",
		"bunny",
		"otter",
		"panda",
		"robin",
		"gecko",
		"ferret",
		"hedgehog",
		"hamster",
		"duckling",
		"fawn",
		"cub",
		"owlet",
		"piglet",
		"lamb",
		"angel",
		"ermine",
		"white-weasel",
	]
	function randomToolName() {
		const adj =
			TOOL_ADJECTIVES[Math.floor(Math.random() * TOOL_ADJECTIVES.length)]
		const noun = TOOL_NOUNS[Math.floor(Math.random() * TOOL_NOUNS.length)]
		return adj + "-" + noun
	}

	let computerFolderUrl: AutomergeUrl | null = null

	// The COMPACT prompt — terse, for small/local models with limited context.
	// Capable cloud models get COMPUTER_SYSTEM_PROMPT_FULL below, which keeps the
	// worked code examples (the compact version's lack of them regressed tool
	// generation — models emitted `load(){ return { Tool } }` instead of
	// `return Tool`). computerSystemPrompt() picks between them by provider.
	const COMPUTER_SYSTEM_PROMPT_COMPACT = `You are Computer, a computer program in a Patchwork collaborative chat. Respond like a computer program — direct, precise, no anthropomorphic fluff. Never prefix messages with [Computer] or your name (other users show as "[Name] message"; that's just context formatting, don't imitate it).

## Patchwork / Automerge
Docs are Automerge CRDTs synced peer-to-peer.
- \`const h = await window.repo.find("automerge:…")\` → handle; \`h.doc()\` reads a snapshot; \`h.change(d => { d.x = … })\` mutates; \`h.on("change", fn)\` listens.
- \`import { splice } from "@automerge/automerge/slim"\` for text edits. Docs can't hold \`undefined\` — use \`null\` or \`delete d.x\`.

## Tools
Call a tool with a fenced block; you get the result back, then continue:
\`\`\`tool-call
tool: name
arg: value
\`\`\`
- read_doc {url} — read a doc
- edit_doc {url, field, value(JSON)} — set a field (strings diff collaboratively); returns the field's new value
- splice_doc {url, field, index, deleteCount, insert} — targeted text edit
- create_doc {data(JSON)} — returns the new url
- pin_tool {url, toolId?, name?} — pin a doc to the sidebar
- edit_tool {toolId|url, code} — replace a tool's source and reload
- inspect_iframe {url} — a pinned tool's DOM + console errors
- eval_in_iframe {url, code} — run JS in a pinned tool, get the result

Rules: ALWAYS read_doc before edit_doc/splice_doc, and re-read the returned value after (peers may have changed it). NEVER change a doc's \`@patchwork.type\`, or a tool's datatype/tool \`id\`/\`supportedDatatypes\` (breaks existing docs). To ask the user something, reply in plain text with NO tool call — tool results are not user answers.

## Building a tool
Output the COMPLETE module in a \`\`\`patchwork-tool block. Follow this skeleton EXACTLY — note what each \`load()\` returns:
\`\`\`patchwork-tool
const datatype = {
  init(doc) { doc.title = "My Tool"; },
  getTitle(doc) { return doc.title || "My Tool"; },
  setTitle(doc, t) { doc.title = t; },
};
export function Tool(handle, element) {
  const root = document.createElement("div");
  element.appendChild(root);
  function render() { const doc = handle.doc(); /* build UI, handlers call handle.change() */ }
  handle.on("change", render); render();
  return () => { handle.off("change", render); root.remove(); }; // ALWAYS return cleanup
}
export const plugins = [
  { type: "patchwork:datatype", id: "ID", name: "NAME", icon: "Box", async load() { return datatype; } },
  { type: "patchwork:tool", id: "ID", name: "NAME", icon: "Box", supportedDatatypes: ["ID"], async load() { return Tool; } },
];
\`\`\`
CRITICAL: the datatype \`load()\` returns \`datatype\` and the tool \`load()\` returns \`Tool\` — return the value DIRECTLY, never \`return { Tool }\` (that breaks the tool). \`icon\` is a lucide name ("Box", "Music", …).

Rules: vanilla DOM only (solid-js is in the importmap if you truly need reactivity — never React). Light DOM, so prefix ALL CSS classes. \`icon\` is a lucide name ("Box", "Music", …). \`repo.find\`/\`repo.create2\` return already-ready handles — \`await\` them (no whenReady; \`create()\` is deprecated). Self-contained, one file. NEVER \`stopPropagation()\` on \`click\` (frameworks delegate it to document) — only on pointerdown/up. When updating a tool, keep its ids and bump \`lastSyncAt = Date.now()\` on the root folder doc to trigger a reload.

## Theming (inside tools)
Derive fill/line/fonts from \`--editor-*\`; accents from \`--studio-*\`. Never hardcode colors or add prefers-color-scheme.
- bg \`var(--editor-fill)\`, fg \`var(--editor-line)\`; offsets \`--editor-fill-offset-10…-50\`, \`--editor-line-offset-10…-50\`
- accents \`--studio-primary|secondary|danger|warning|link\`; spacing \`--studio-space-2xs…-2xl\`; radius \`--studio-radius-sm…-xl\`
- lighten/darken via \`color-mix(in oklch, var(--editor-fill), var(--editor-line) 8%)\` (so it inverts in dark themes)

## Also
- Importmap (bare imports, no CDN): \`@automerge/automerge\`, \`@automerge/automerge-repo\`, \`solid-js\` (+\`/web\` \`/html\` \`/store\`), \`@codemirror/state|view|language\`, \`@inkandswitch/patchwork-elements|filesystem|plugins\`.
- Ephemeral peer messages: \`handle.broadcast({…})\` / \`handle.on("ephemeral-message", ({message}) => …)\` — connected peers only, not persisted.
- Files: \`automergeUrlToServiceWorkerUrl(url)\` from patchwork-filesystem → usable as \`<img src>\`/\`<audio src>\`.
- Navigate: \`openDocument(element, url, toolId)\` from patchwork-elements.
- Rich output: \`\`\`file blocks create+embed files; \`\`\`embed blocks embed existing docs.

Keep responses concise. When you build a tool, briefly say what it does.`

	// The FULL prompt — detailed, with worked code examples — for capable cloud
	// models (OpenRouter / Ollama). Same intro + tool-calling section as the
	// compact prompt, but the tool-building / theming / capabilities guidance is
	// spelled out with concrete examples so the model produces a correct plugins
	// array (e.g. \`load(){ return Tool }\`, not \`return { Tool }\`).
	const COMPUTER_SYSTEM_PROMPT_FULL = `You are Computer, a computer program in a Patchwork collaborative chat. Respond like a computer program — direct, precise, no anthropomorphic fluff. Never prefix messages with [Computer] or your name (other users show as "[Name] message"; that's just context formatting, don't imitate it).

## Patchwork / Automerge
Docs are Automerge CRDTs synced peer-to-peer.
- \`const h = await window.repo.find("automerge:…")\` → handle; \`h.doc()\` reads a snapshot; \`h.change(d => { d.x = … })\` mutates; \`h.on("change", fn)\` listens.
- \`import { splice } from "@automerge/automerge/slim"\` for text edits. Docs can't hold \`undefined\` — use \`null\` or \`delete d.x\`.

## Tools
Call a tool with a fenced block; you get the result back, then continue:
\`\`\`tool-call
tool: name
arg: value
\`\`\`
- read_doc {url} — read a doc
- edit_doc {url, field, value(JSON)} — set a field (strings diff collaboratively); returns the field's new value
- splice_doc {url, field, index, deleteCount, insert} — targeted text edit
- create_doc {data(JSON)} — returns the new url
- pin_tool {url, toolId?, name?} — pin a doc to the sidebar
- edit_tool {toolId|url, code} — replace a tool's source and reload
- inspect_iframe {url} — a pinned tool's DOM + console errors
- eval_in_iframe {url, code} — run JS in a pinned tool, get the result

Rules: ALWAYS read_doc before edit_doc/splice_doc, and re-read the returned value after (peers may have changed it). NEVER change a doc's \`@patchwork.type\`, or a tool's datatype/tool \`id\`/\`supportedDatatypes\` (breaks existing docs). To ask the user something, reply in plain text with NO tool call — tool results are not user answers.

## Building a Patchwork Tool
When asked to build something, output the COMPLETE JavaScript module in a fenced code block tagged \`\`\`patchwork-tool.

Your tool MUST export these three things:

1. **Datatype** — manages document lifecycle:
\`\`\`js
export const MyDatatype = {
  init(doc) { doc.title = "My Tool"; /* set defaults */ },
  getTitle(doc) { return doc.title || "My Tool"; },
  setTitle(doc, title) { doc.title = title; },
};
\`\`\`

2. **Tool function** — renders UI, returns cleanup:
\`\`\`js
export function Tool(handle, element) {
  const style = document.createElement("style");
  style.textContent = \\\`.prefix-container { ... }\\\`;
  element.appendChild(style);
  const container = document.createElement("div");
  container.className = "prefix-container";
  element.appendChild(container);

  function render() {
    const doc = handle.doc();
    if (!doc) return;
    container.innerHTML = "";
    // Build UI with DOM APIs, attach click handlers that call handle.change()
  }
  render();
  handle.on("change", render);
  return () => { handle.off("change", render); container.remove(); style.remove(); };
}
\`\`\`

3. **plugins array** — registers both:
\`\`\`js
export const plugins = [
  { type: "patchwork:datatype", id: "my-datatype-id", name: "My Tool Name", icon: "Box", async load() { return MyDatatype; } },
  { type: "patchwork:tool", id: "my-tool-id", name: "My Tool Name", icon: "Box", supportedDatatypes: ["my-datatype-id"], async load() { return Tool; } },
];
\`\`\`

Rules:
- Use vanilla DOM APIs only (createElement, innerHTML, etc.) — NO frameworks. (If you genuinely need fine-grained reactivity, \`solid-js\` is in the importmap — but reach for it only when hand-diffing the DOM gets painful. Never React.)
- \`icon\` is a [lucide](https://lucide.dev) icon NAME, e.g. "Box", "Music", "Grid3x3", "File", "Sparkles".
- No shadow DOM — tools render into the light DOM, so scope ALL CSS classes with a unique prefix to avoid conflicts.
- **Never call \`stopPropagation()\` on a \`click\` event.** Patchwork frameworks (Solid, tldraw host) delegate \`click\` to \`document\`; stopping it kills their handlers. Only stop propagation on \`pointerdown\`/\`pointerup\`.
- \`repo.find(url)\` and \`repo.create2(initial)\` return Promises that resolve to an already-ready handle — \`const handle = await repo.find(url)\`. Never use the old \`repo.find(url); await handle.whenReady()\` pattern. (\`repo.create()\` is deprecated — use \`create2\`.)
- The datatype id and supportedDatatypes must match. The tool id can be different — a tool can support an existing datatype. When creating a new self-contained tool, use the suggested tool ID for both.
- Keep it self-contained in one file.
- Always RETURN a cleanup function from the tool that tears down everything: \`handle.off("change", …)\`, removed nodes, cleared intervals/timeouts/rAF, closed AudioContexts.
- Automerge docs cannot contain \`undefined\` — use \`null\` or \`delete d.field\` inside a \`change()\`.
- Strings in Automerge are collaborative text; use \`splice()\` for efficient editing, or just assign for simple values

## Styling & Theming
Patchwork supplies CSS custom properties — derive from them so your tool matches the active theme. **Never hardcode hex colors** and **never add \`@media (prefers-color-scheme)\` blocks** — the theme system swaps the variable values to handle light/dark for you. (In a tool, derive fill/line/typography from \`--editor-*\`; accents come from \`--studio-*\`, which has no editor equivalent.)

- Background / foreground: \`var(--editor-fill, white)\` / \`var(--editor-line, black)\`
- Tinted backgrounds: \`var(--editor-fill-offset-10)\` … \`-50\`; muted text: \`var(--editor-line-offset-10)\` … \`-50\`
- Accent colors: \`var(--studio-primary)\`, \`--studio-secondary\`, \`--studio-danger\`, \`--studio-warning\`, \`--studio-link\`
- Fonts: \`var(--editor-family-sans, system-ui, sans-serif)\`, \`var(--editor-family-code, ui-monospace, monospace)\`, \`var(--editor-font-size, 16px)\`, \`var(--editor-line-height, 1.5)\`
- Spacing \`var(--studio-space-2xs)\` … \`-2xl\`; radius \`var(--studio-radius-sm)\` … \`-xl\` (\`-round\` for pills); shadows \`var(--studio-shadow-sm)\` … \`-lg\`
- To go lighter/darker, mix toward fill or line (NOT literal white/black, so it inverts in dark themes): \`color-mix(in oklch, var(--editor-fill), var(--editor-line) 8%)\`

## More Capabilities
- **Importmap (bare imports, no CDN):** \`@automerge/automerge\`, \`@automerge/automerge-repo\`, \`solid-js\` (+ \`/web\` \`/html\` \`/store\`), \`@codemirror/state|view|language\`, and \`@inkandswitch/patchwork-elements|filesystem|plugins\`. Import these by bare specifier — never esm.sh/unpkg for them.
- **Ephemeral (non-persisted) peer messages** for presence / cursors / typing indicators: \`handle.broadcast({ type: "ping" })\` and \`handle.on("ephemeral-message", ({ message }) => …)\`. Delivered only to currently-connected peers, never written to the doc.
- **Files & assets:** \`import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem"\` turns a file doc's automerge URL into a URL usable as \`<img src>\` / \`<audio src>\`.
- **Navigate to another document:** \`import { openDocument } from "@inkandswitch/patchwork-elements"; openDocument(element, url, toolId)\`.

## Updating Existing Tools
When you update files in a tool folder (e.g. updating JS source via edit_doc or patchwork-tool), you MUST also update the \`lastSyncAt\` field on the root folder doc with the current epoch timestamp (\`Date.now()\`). This triggers the module system to reload.

**CRITICAL — Never change IDs:** When updating an existing tool's source code (whether via edit_doc, splice_doc, or a patchwork-tool block), you MUST keep the existing datatype \`id\`, tool \`id\`, and \`supportedDatatypes\` values exactly as they are. These IDs are how Patchwork connects the tool code to existing documents. If you change them, all existing documents of that type will break and the tool will stop rendering. Use read_doc first to check the current IDs and preserve them exactly.

## Rich Messages
You can include \`\`\`file blocks to create and embed files, \`\`\`embed blocks for existing docs.

Keep responses concise. When you create a tool, explain briefly what it does.`

	// The prompt to show in the picker.
	function computerSystemPrompt(): string {
		if (isContext()) return CONTEXT_SYSTEM_PROMPT
		return COMPUTER_SYSTEM_PROMPT_FULL
	}

	// Local/in-browser models (small, limited context) get the compact prompt;
	// cloud providers get the full one with worked examples. Only the host knows
	// the provider, so both are sent and the worker picks.
	function computerSystemForFrame(): string | Record<string, string> {
		if (isContext()) return CONTEXT_SYSTEM_PROMPT
		return {
			default: COMPUTER_SYSTEM_PROMPT_FULL,
			local: COMPUTER_SYSTEM_PROMPT_COMPACT,
		}
	}

	// @computer's tools as lib tool schemas. Passed to generate({tools}) so the
	// model gets native function-calling (OpenRouter/Ollama) or the <tool_call>
	// convention (local). They run in-process via runToolByName (live repo/DOM/
	// iframe access), so no `handler` here. Users can disable individual tools in
	// the model picker (cfg.toolToggles).
	// A meta-tool: lets the computer EXTEND its own toolset by writing JavaScript.
	// The new tool is persisted on the chat doc (computerCustomTools) and offered on
	// the computer's NEXT run. Powerful (runs arbitrary JS in-process), so it's
	// DEFAULT-OFF (GLOBAL_DEFAULT_OFF) — enable per-doc in the model picker.
	// Ask the user a question and PAUSE: posts the question (with optional clickable
	// choices) to the chat and ends the turn. The user's reply arrives as a new
	// message the computer then responds to — so it's non-blocking by design.
	const ASK_USER_TOOL = {
		name: "ask_user",
		description:
			"Ask the user a question and wait for their answer. Posts your question to the chat (with optional clickable choices) and ENDS your turn — do not call other tools after it. Their reply comes back as a new message you'll then respond to. Use when you need a decision or missing detail before continuing.",
		parameters: {
			type: "object",
			properties: {
				question: {type: "string", description: "the question to ask"},
				options: {
					type: "array",
					items: {type: "string"},
					description: "optional suggested answers, shown as clickable buttons",
				},
			},
			required: ["question"],
		},
	}
	const DEFINE_TOOL = {
		name: "define_tool",
		description:
			"Extend your OWN toolset: define a new tool by writing a JavaScript body. It is saved and becomes callable on your NEXT run (not this turn). The code runs in-process as `async (args, ctx) => { <your code> }` where ctx = {repo, handle (this chat), element, focusedUrl, applyAutomerge}; return a value (string or JSON). Use this to build whatever capability a task needs. Disabled by default.",
		parameters: {
			type: "object",
			properties: {
				name: {type: "string", description: "tool name — identifier chars only (e.g. word_count)"},
				description: {type: "string", description: "what the tool does + when to use it"},
				parameters: {type: "object", description: "JSON Schema for the tool's args (an object schema)"},
				code: {type: "string", description: "JS function body. Receives (args, ctx); return the result. async/await allowed."},
			},
			required: ["name", "description", "code"],
		},
	}
	const COMPUTER_TOOLS: {name: string; description: string; parameters: any}[] = [
		{name: "read_doc", description: "Read an Automerge document's full contents.", parameters: {type: "object", properties: {url: {type: "string", description: "automerge: URL"}}, required: ["url"]}},
		{name: "edit_doc", description: "Set a field on a document (string fields diff collaboratively). Returns the field's new value.", parameters: {type: "object", properties: {url: {type: "string"}, field: {type: "string"}, value: {description: "new value (JSON)"}}, required: ["url", "field", "value"]}},
		{name: "splice_doc", description: "Targeted text edit on a string field: delete deleteCount chars at index, insert text. read_doc first for indices.", parameters: {type: "object", properties: {url: {type: "string"}, field: {type: "string"}, index: {type: "number"}, deleteCount: {type: "number"}, insert: {type: "string"}}, required: ["url", "field", "index"]}},
		{name: "create_doc", description: "Create a new document with initial data. Returns the new automerge URL.", parameters: {type: "object", properties: {data: {description: "initial doc (JSON object)"}}, required: ["data"]}},
		{name: "pin_tool", description: "Pin a document to the chat sidebar for everyone.", parameters: {type: "object", properties: {url: {type: "string"}, toolId: {type: "string"}, name: {type: "string"}}, required: ["url"]}},
		{name: "edit_tool", description: "Replace an existing tool's source code and reload it. Target by toolId or url.", parameters: {type: "object", properties: {toolId: {type: "string"}, url: {type: "string"}, code: {type: "string"}}, required: ["code"]}},
		{name: "inspect_iframe", description: "Get a pinned tool iframe's DOM HTML and console errors.", parameters: {type: "object", properties: {url: {type: "string"}}}},
		{name: "eval_in_iframe", description: "Run JS inside a pinned tool's iframe and return the result.", parameters: {type: "object", properties: {url: {type: "string"}, code: {type: "string"}}, required: ["code"]}},
		ASK_USER_TOOL,
		DEFINE_TOOL,
	]

	// ---- Context-tool ("context-tool" tag) mode ----------------------------
	// The streamlined variant edits whatever document the user has FOCUSED, using
	// a universal Automerge op tool instead of the tool-building tools above.
	const CONTEXT_SYSTEM_PROMPT = `You are Computer, a computer program embedded in Patchwork's context sidebar. You help edit the document the user currently has FOCUSED. Respond like a computer program — direct, precise, no anthropomorphic fluff. Never prefix messages with [Computer] or your name (other users show as "[Name] message"; that's just context formatting).

## What you're editing
Every turn, a [Context] block gives you the focused document: its \`url\`, its current \`heads\`, its \`type\`, and a snapshot of its contents (possibly truncated — call read_doc for the full doc). All your edits go to THIS document unless the user gives another url. It is a live Automerge CRDT synced peer-to-peer, so other people may be editing it at the same time as you.

## Automerge / Patchwork in 30 seconds
- A document is a JSON-like tree: maps (objects), lists (arrays), strings (collaborative TEXT, edited by character splice), numbers, booleans, bytes (Uint8Array).
- Documents CANNOT hold \`undefined\` — to remove something, delete the key (an automerge_op with no value).
- Strings are collaborative text: never overwrite a whole string when you mean to change part of it — splice the changed range so concurrent edits merge instead of clobbering.
- Patchwork metadata lives under \`@patchwork\` (e.g. \`@patchwork.type\`). NEVER change \`@patchwork.type\` — it binds the doc to its tool and renaming it breaks the document.

## Tools
- read_doc {url?} — read a document (defaults to the focused doc). Returns its full JSON contents AND its current \`heads\`. ALWAYS read_doc before a non-trivial edit, and pass the returned heads to automerge_op only if you want a back-dated change.
- find_text {query, path?, url?} — locate a substring so you DON'T have to count characters. Returns every match as {path, start, end, context}. Feed start/end straight into an automerge_op range.
- replace_text {find, replace, path?, occurrence?, url?} — the EASY, preferred way to edit text: find-and-replace a literal substring, no offsets at all. It splices just that range (collaborative-safe). Errors if \`find\` is missing or ambiguous (then add \`occurrence\` (1-based) or a \`path\`). Empty \`replace\` deletes. To replace a tangled multi-line region, pass the whole bad text as \`find\` and the corrected text as \`replace\`.
- automerge_op {path?, range, value?, heads?, url?} — the general primitive for STRUCTURED edits (maps, lists, numbers) and precise text splices. One op expresses every edit:
    • path — array of keys/indices from the doc root to the container or string you're touching. \`[]\` is the root. e.g. \`["settings","color"]\`, \`["items"]\`, \`["body"]\`.
    • range — TWO MODES:
        ◦ \`[from, to]\` (an array) = SPLICE: replace the half-open slice \`from\` (inclusive) … \`to\` (exclusive) — exactly JS \`slice(from,to)\`. \`[5,5]\` inserts at 5 (deletes nothing); \`[3,7]\` covers the 4 items at 3,4,5,6.
            – on a STRING field (path points AT the string): from/to are 0-based CHARACTER offsets, NOT lines — every char counts, and each newline (\\n) is ONE char. Prefer replace_text/find_text so you never hand-count; use a raw splice only when you already have exact offsets from find_text. Insert "hi" at char 5 → path:["body"], range:[5,5], value:"hi". Delete chars 3–6 → path:["body"], range:[3,7] (no value).
            – on a LIST (path points AT the array): a list edit. value is the item(s) to insert (an array, or a single item). Insert at index 2 → path:["items"], range:[2,2], value:[{...}]. Delete items[2] → path:["items"], range:[2,3] (no value).
        ◦ a string/number KEY = ASSIGN or DELETE on the map/list at \`path\`.
            – set d.title → path:[], range:"title", value:"New title".
            – set d.settings.color → path:["settings"], range:"color", value:"red".
            – delete d.draft → path:[], range:"draft" (no value).
    • value — what to insert/set. Omit it (or null) to delete. JSON of any shape for maps/lists.
    • heads — OPTIONAL. The heads array from read_doc. When given, the edit is applied as a back-dated change (changeAt) relative to that version. Omit for a normal "edit current state" change.
    • url — OPTIONAL. Edit a different document than the focused one.
  Returns the affected container's new value so you can verify.
- ask_user {question, options?} — ask the user something and PAUSE. Posts your question (with optional clickable choices) and ends your turn; their reply comes back as a new message. Use this instead of guessing when you need a decision or missing detail.
- inspect_dom {selector?} — (usually disabled) return the live DOM HTML of the running tool/page, optionally narrowed to a CSS selector. Use to see how the focused doc is actually rendered.
- eval_js {code} — (usually disabled) evaluate JavaScript in the page and return the result. Powerful and unsandboxed; only when explicitly needed.

## Editing text — this is where edits go wrong, so follow it
The reliable recipe for ANY text change:
1. read_doc to get the field's EXACT current string — don't trust a truncated snapshot or your memory; whitespace and newlines must match.
2. Use replace_text {find, replace}: paste the exact substring to change as \`find\` and the new text as \`replace\`. No counting. For a corrupted multi-line region, make \`find\` the whole bad span and \`replace\` the corrected text — ONE clean replacement beats many fragile splices.
3. If you genuinely need positions (e.g. an insertion point with no nearby text), call find_text to get exact {start,end}, then automerge_op range:[start,end].
4. Read the returned value to confirm the edit landed; if it's off, your \`find\`/offsets didn't match the real text — read_doc again and retry.
Never overwrite an entire long field with a key-assign (range:"content") just to fix part of it — that discards everyone's concurrent edits. Edit the smallest correct span.

## Rules
- read_doc → edit → then verify (check the returned value, or read_doc again). Offsets and list indices shift under concurrent edits, so a stale read = a wrong edit.
- For text, reach for replace_text first, find_text second, raw automerge_op splices last. Edit the smallest correct span; don't overwrite whole fields.
- Never change \`@patchwork.type\`. Don't invent fields the tool won't understand — match the document's existing shape.
- To ASK the user something, use ask_user (or just reply in plain text with no tool call). Tool results are never the user's answer.
- Keep replies concise. After editing, say briefly what you changed.`

	// Default-OFF tools in context mode: DOM inspection + arbitrary JS eval are
	// powerful/unsandboxed, so they're opt-in (enable per-doc in the picker).
	const CONTEXT_DEFAULT_OFF = ["inspect_dom", "eval_js"]
	const CONTEXT_TOOLS: {name: string; description: string; parameters: any}[] = [
		{name: "read_doc", description: "Read a document's full JSON contents AND its current heads (defaults to the focused document). Pass the heads to automerge_op for a back-dated change.", parameters: {type: "object", properties: {url: {type: "string", description: "automerge: URL (optional; defaults to the focused doc)"}}}},
		{name: "find_text", description: "Locate a substring in the document's string fields so you DON'T have to count character offsets by hand. Returns every match as {path, start, end, context}. Use start/end directly as an automerge_op range. Searches all string fields, or just the one at `path` if given.", parameters: {type: "object", properties: {query: {type: "string", description: "the exact substring to locate"}, path: {type: "array", items: {}, description: "optional: restrict to the string field at this path"}, url: {type: "string", description: "optional target doc (defaults to the focused doc)"}}, required: ["query"]}},
		{name: "replace_text", description: "Find-and-replace a literal substring in a string field — the EASY way to edit text, with no character counting. Replaces `find` with `replace` (collaboratively, splicing just that range). Errors if `find` is absent or ambiguous (then pass `occurrence`, or a `path`, to disambiguate). To delete text, use an empty `replace`.", parameters: {type: "object", properties: {find: {type: "string", description: "exact substring to replace"}, replace: {type: "string", description: "replacement text (empty string deletes)"}, path: {type: "array", items: {}, description: "optional: the string field to edit (else the unique field containing `find`)"}, occurrence: {type: "number", description: "optional 1-based index when `find` occurs more than once"}, url: {type: "string", description: "optional target doc (defaults to the focused doc)"}}, required: ["find", "replace"]}},
		{name: "automerge_op", description: "Apply ONE universal Automerge edit to a doc (defaults to the focused doc). range=[from,to] splices a string field (text — from/to are 0-based CHARACTER offsets, to exclusive, every char incl. newlines counts) or a list; range=key assigns (with value) or deletes (without value) on the map/list at path. Omit value to delete. For text, prefer replace_text/find_text so you don't miscount.", parameters: {type: "object", properties: {path: {type: "array", items: {}, description: "keys/indices from the doc root to the container or string ([]=root)"}, range: {description: "[from,to] for a splice, or a string/number key for assign/delete"}, value: {description: "value to insert/set (JSON); omit to delete"}, heads: {type: "array", items: {type: "string"}, description: "optional heads (from read_doc) → back-dated changeAt"}, url: {type: "string", description: "optional target doc (defaults to the focused doc)"}}, required: ["range"]}},
		{name: "inspect_dom", description: "Return the live DOM HTML of the running tool/page (optionally narrowed by a CSS selector). Disabled by default.", parameters: {type: "object", properties: {selector: {type: "string", description: "optional CSS selector to narrow the result"}}}},
		{name: "eval_js", description: "Evaluate JavaScript in the page and return the result. Unsandboxed. Disabled by default.", parameters: {type: "object", properties: {code: {type: "string"}}, required: ["code"]}},
		ASK_USER_TOOL,
		DEFINE_TOOL,
	]

	// Always opt-IN, in any mode: define_tool runs arbitrary JS the model writes.
	const GLOBAL_DEFAULT_OFF = ["define_tool"]

	// Tools the computer defined for itself via define_tool, as lib tool schemas
	// (code stripped). Read live from the doc so a tool defined last turn shows up.
	function customTools(): {name: string; description: string; parameters: any}[] {
		const list = (props.handle.doc() as any)?.computerCustomTools
		if (!Array.isArray(list)) return []
		return list
			.filter((t: any) => t && typeof t.name === "string")
			.map((t: any) => ({
				name: t.name,
				description: t.description || "(custom tool)",
				parameters:
					t.parameters && typeof t.parameters === "object"
						? t.parameters
						: {type: "object", properties: {}},
			}))
	}

	// The tool set for whichever mode we're in, plus any self-defined tools.
	function activeTools() {
		return [...(isContext() ? CONTEXT_TOOLS : COMPUTER_TOOLS), ...customTools()]
	}

	// Render a structured tool call as the text shown in its rich-block card.
	function renderCallText(call: any): string {
		const a = call.args || {}
		const lines = Object.entries(a).map(
			([k, v]) => k + ": " + (typeof v === "string" ? v : JSON.stringify(v))
		)
		return ["tool: " + call.name, ...lines].join("\n")
	}

	// The active mode's tools, with opt-in ones marked `defaultOff`. The worker
	// drops whichever the user's toggles turn off.
	function enabledComputerTools() {
		return activeTools().map((t) => ({
			...t,
			defaultOff:
				GLOBAL_DEFAULT_OFF.includes(t.name) ||
				(isContext() && CONTEXT_DEFAULT_OFF.includes(t.name)),
		}))
	}

	// ---- LLM generation ----
	// Runs on the host, over @grjte/patchwork-worker. The host resolves provider,
	// model, key and sampling from `scope`.
	async function generateLLM(
		messages: any[],
		onToken: (text: string) => void,
		signal?: AbortSignal,
		onStatus?: (status: string) => void,
		system?: string | Record<string, string>,
		tools?: any[],
		onModel?: (label: string) => void
	): Promise<{text: string; toolCalls: any[] | null}> {
		const client = await llmClient()
		const {text, toolCalls} = await client.generate(messages, {
			sessionKey: props.handle.url,
			// The worker-channel request is dispatched from here.
			element: props.element,
			scope: llmScope(),
			...(system ? {system} : {}),
			// Calls come back here to be run by runToolByName.
			...(tools && tools.length ? {tools} : {}),
			onToken: (_delta: string, full: string) => onToken(full),
			onStatus: (status: string) => onStatus?.(status),
			onModel,
			signal,
		})
		return {text, toolCalls: (toolCalls as any) || null}
	}


	// ---- Rich block parsing ----
	function parseRichBlocks(response: string) {
		const blocks: {
			type: string
			meta: string
			content: string
			fullMatch: string
		}[] = []
		let remaining = response
		const blockRe =
			/```(patchwork-tool|file|embed|tool-call|image)([ \t]+[^\n]*)?\n([\s\S]*?)```/g
		let match
		while ((match = blockRe.exec(response)) !== null) {
			blocks.push({
				type: match[1],
				meta: (match[2] || "").trim(),
				content: match[3],
				fullMatch: match[0],
			})
			remaining = remaining.replace(match[0], "")
		}
		return {blocks, text: remaining.trim()}
	}

	function parseMeta(meta: string): Record<string, string> {
		const result: Record<string, string> = {}
		const re = /(\w+)=(\S+)/g
		let m
		while ((m = re.exec(meta)) !== null) result[m[1]] = m[2]
		return result
	}

	async function processRichBlocks(parsed: {blocks: any[]; text: string}) {
		const repo = (props.element as any).repo
		const encoder = new TextEncoder()
		const embeds: any[] = []
		let extraText = ""
		for (const block of parsed.blocks) {
			if (block.type === "patchwork-tool") {
				const result = await createAndPinTool(block.content)
				extraText += result?.updated
					? "\n\n*Updated tool **" + result.toolName + "**.*"
					: "\n\n*Created tool **" +
						(result?.toolName || "tool") +
						"** and pinned it in the sidebar.*"
			} else if (block.type === "file") {
				const meta = parseMeta(block.meta)
				const name = meta.name || "file.txt"
				const mimeType = meta.mimeType || "text/plain"
				const isText =
					mimeType.startsWith("text/") ||
					mimeType === "application/javascript" ||
					mimeType === "application/json"
				const content = isText ? block.content : encoder.encode(block.content)
				const ext = name.includes(".") ? "." + name.split(".").pop() : ""
				const fileHandle = await repo.create2({
					content,
					name,
					extension: ext,
					mimeType,
					"@patchwork": {type: "file"},
				})
				embeds.push({docUrl: fileHandle.url, title: name})
			} else if (block.type === "image") {
				const meta = parseMeta(block.meta)
				const name = meta.name || "image.png"
				const mimeType = meta.mimeType || "image/png"
				// Decode base64 image content
				try {
					const binary = atob(block.content.trim())
					const bytes = new Uint8Array(binary.length)
					for (let i = 0; i < binary.length; i++)
						bytes[i] = binary.charCodeAt(i)
					const ext = name.includes(".") ? "." + name.split(".").pop() : ".png"
					const fileHandle = await repo.create2({
						content: bytes,
						name,
						extension: ext,
						mimeType,
						"@patchwork": {type: "file"},
					})
					embeds.push({docUrl: fileHandle.url, title: name})
				} catch (e) {
					console.warn("[Chat] image block decode:", e)
				}
			} else if (block.type === "embed") {
				const lines = block.content.trim().split("\n")
				let docUrl = "",
					title = ""
				for (const line of lines) {
					const kv = line.match(/^\s*(\w+)\s*:\s*(.+)$/)
					if (kv) {
						if (kv[1] === "docUrl") docUrl = kv[2].trim()
						else if (kv[1] === "title") title = kv[2].trim()
					}
				}
				if (docUrl) embeds.push({docUrl, title})
			}
		}
		const opts: any = {}
		if (embeds.length > 0) opts.embeds = embeds
		return {text: (parsed.text + extraText).trim(), opts}
	}

	// ---- Tool execution ----
	function parseToolCallArgs(content: string): Record<string, string> {
		const args: Record<string, string> = {}
		const lines = content.replace(/\r\n/g, "\n").split("\n")
		const knownKeys = new Set([
			"tool",
			"url",
			"field",
			"value",
			"data",
			"toolId",
			"tool_id",
			"name",
			"index",
			"deleteCount",
			"insert",
			"code",
			"sourceUrl",
			"source_url",
			"jsUrl",
			"js_url",
			"content",
		])
		const multilineTerminalKeys = new Set([
			"code",
			"content",
			"value",
			"insert",
			"data",
		])

		let currentKey: string | null = null
		let lockToCurrentKey = false

		for (const rawLine of lines) {
			const topLevel = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
			if (!lockToCurrentKey && topLevel && knownKeys.has(topLevel[1])) {
				currentKey = topLevel[1]
				args[currentKey] = topLevel[2]
				if (multilineTerminalKeys.has(currentKey)) {
					lockToCurrentKey = true
				}
				continue
			}
			if (currentKey) {
				args[currentKey] += "\n" + rawLine
			}
		}

		for (const k of Object.keys(args)) {
			if (k !== "code" && k !== "content") args[k] = args[k].trim()
		}
		return args
	}

	function normalizeAutomergeUrl(v?: string): string {
		if (!v) return ""
		if (v.startsWith("automerge:")) return v
		return "automerge:" + v
	}

	async function resolveToolSourceFromArgs(
		repo: any,
		args: Record<string, string>
	): Promise<{
		toolId: string
		toolName: string
		folderUrl: string
		sourceUrl: string
		sourceName: string
	}> {
		const sourceUrlArg = normalizeAutomergeUrl(
			args.sourceUrl || args.source_url || args.jsUrl || args.js_url
		)
		const urlArg = normalizeAutomergeUrl(args.url)
		const toolIdArg = args.toolId || args.tool_id || ""

		if (sourceUrlArg) {
			const sh = await repo.find(sourceUrlArg)
			const sd = sh.doc() as any
			if (typeof sd?.content !== "string") {
				throw new Error("sourceUrl does not point to a JS text file doc")
			}
			return {
				toolId: toolIdArg || "tool",
				toolName: toolIdArg || sd?.name || "tool",
				folderUrl: "",
				sourceUrl: sourceUrlArg,
				sourceName: sd?.name || "tool.js",
			}
		}

		const chatDoc = props.handle.doc() as any
		const pinned = (chatDoc?.docs || []).filter((d: any) => !!d.pin)

		let targetPin: any = null
		if (toolIdArg) {
			targetPin =
				pinned.find(
					(d: any) =>
						d.pin === toolIdArg || d.type === toolIdArg || d.name === toolIdArg
				) || null
		}

		if (!targetPin && urlArg) {
			targetPin = pinned.find((d: any) => d.url === urlArg) || null
		}

		if (!targetPin && !toolIdArg && !urlArg && pinned.length === 1) {
			targetPin = pinned[0]
		}

		if (!targetPin && toolIdArg) {
			throw new Error("No pinned tool found for toolId '" + toolIdArg + "'")
		}
		if (!targetPin && urlArg) {
			const direct = await repo.find(urlArg)
			const dd = direct.doc() as any
			const jsEntry = dd?.docs?.find((x: any) => x?.name?.endsWith(".js"))
			if (jsEntry) {
				return {
					toolId: toolIdArg || dd?.title || "tool",
					toolName: dd?.title || toolIdArg || "tool",
					folderUrl: urlArg,
					sourceUrl: jsEntry.url,
					sourceName: jsEntry.name || "tool.js",
				}
			}
			throw new Error("No pinned tool or tool folder found for url")
		}
		if (!targetPin) {
			throw new Error(
				"No tool target specified. Provide toolId, url, or sourceUrl."
			)
		}

		const instanceUrl = normalizeAutomergeUrl(targetPin.url)
		const instanceHandle = await repo.find(instanceUrl)
		const instanceDoc = instanceHandle.doc() as any
		const folderUrl = normalizeAutomergeUrl(
			instanceDoc?.["@patchwork"]?.suggestedImportUrl ||
				targetPin.suggestedImportUrl ||
				""
		)
		if (!folderUrl) {
			throw new Error(
				"Pinned doc has no suggestedImportUrl; cannot locate tool source"
			)
		}

		const folderHandle = await repo.find(folderUrl)
		const folderDoc = folderHandle.doc() as any
		const jsEntry = folderDoc?.docs?.find((d: any) => d?.name?.endsWith(".js"))
		if (!jsEntry?.url) throw new Error("Tool folder has no .js source entry")

		return {
			toolId:
				toolIdArg ||
				targetPin.pin ||
				targetPin.type ||
				folderDoc?.title ||
				"tool",
			toolName:
				targetPin.name ||
				folderDoc?.title ||
				targetPin.pin ||
				targetPin.type ||
				"tool",
			folderUrl,
			sourceUrl: jsEntry.url,
			sourceName: jsEntry.name || "tool.js",
		}
	}

	// A located substring match in a doc's string fields (for find_text /
	// replace_text — so the model never hand-counts character offsets).
	type TextMatch = {path: (string | number)[]; start: number; end: number; context: string}

	// Walk every string-valued field of `doc` and collect occurrences of `query`.
	// If `restrict` is given, only the string at that path is searched.
	function findTextMatches(
		doc: any,
		query: string,
		restrict?: (string | number)[] | null
	): TextMatch[] {
		const out: TextMatch[] = []
		const CONTEXT = 24
		const scanString = (s: string, path: (string | number)[]) => {
			let from = 0
			while (out.length < 200) {
				const i = s.indexOf(query, from)
				if (i < 0) break
				const end = i + query.length
				out.push({
					path,
					start: i,
					end,
					context:
						(i > CONTEXT ? "…" : "") +
						s.slice(Math.max(0, i - CONTEXT), i) +
						"⟦" +
						s.slice(i, end) +
						"⟧" +
						s.slice(end, end + CONTEXT) +
						(end + CONTEXT < s.length ? "…" : ""),
				})
				from = end || from + 1 // empty query guard
			}
		}
		if (restrict && restrict.length) {
			let node: any = doc
			for (const k of restrict) node = node == null ? node : node[k]
			if (typeof node === "string") scanString(node, restrict)
			return out
		}
		const walk = (node: any, path: (string | number)[]) => {
			if (out.length >= 200) return
			if (typeof node === "string") {
				scanString(node, path)
			} else if (Array.isArray(node)) {
				for (let i = 0; i < node.length; i++) walk(node[i], [...path, i])
			} else if (node && typeof node === "object") {
				for (const k of Object.keys(node)) walk(node[k], [...path, k])
			}
		}
		walk(doc, [])
		return out
	}

	// Execute one tool call by name with structured args (from the lib's native
	// tool_calls or parsed <tool_call> JSON). Args may already be typed (objects/
	// numbers) or strings, so each branch is tolerant of both. Returns a result
	// string fed back to the model.
	async function runToolByName(toolName: string, rawArgs: any): Promise<string> {
		const args = rawArgs || {}
		const repo = (props.element as any).repo
		// In context mode, doc-editing tools default to the focused document.
		const focusedUrl = () => props.targetDocUrl?.()
		try {
			if (toolName === "read_doc") {
				const url = args.url || (isContext() ? focusedUrl() : undefined)
				if (!url) return "Error: no url and no focused document."
				const h = await repo.find(url)
				const doc = h.doc()
				if (isContext()) {
					// Context mode also returns heads so a follow-up automerge_op can
					// back-date its change (changeAt). handle.heads() is the UrlHeads
					// that changeAt() expects.
					let heads: any = []
					try {
						heads = h.heads()
					} catch {}
					return JSON.stringify({url: h.url, heads, doc}, null, 2)
				}
				return JSON.stringify(doc, null, 2) || "null"
			} else if (toolName === "automerge_op") {
				const url = args.url || focusedUrl()
				if (!url) return "Error: no url and no focused document."
				const h = await repo.find(url)
				// path / range / value may arrive typed (native function calling) or as
				// JSON strings (local <tool_call> convention) — be tolerant of both.
				const parseMaybe = (v: any) => {
					if (typeof v !== "string") return v
					try {
						return JSON.parse(v)
					} catch {
						return v
					}
				}
				const path = Array.isArray(args.path)
					? args.path
					: parseMaybe(args.path) ?? []
				if (!Array.isArray(path)) {
					return "Error: path must be an array of keys/indices."
				}
				const range = parseMaybe(args.range)
				if (range === undefined || range === null) {
					return "Error: range is required ([from,to] for a splice, or a key for assign/delete)."
				}
				let targetBefore = h.doc() as any
				for (const k of path) targetBefore = targetBefore == null ? targetBefore : targetBefore[k]
				const parseValueMaybe = (v: any) => {
					if (typeof v !== "string") return v
					if (Array.isArray(range) && typeof targetBefore === "string") return v
					const trimmed = v.trim()
					if (!/^(?:[{[]|"(?:[^"\\]|\\.)*"|-?\d|true\b|false\b|null\b)/.test(trimmed)) {
						return v
					}
					try {
						return JSON.parse(trimmed)
					} catch {
						return v
					}
				}
				const hasValue = Object.prototype.hasOwnProperty.call(args, "value")
				const value = hasValue ? parseValueMaybe(args.value) : undefined
				const heads = parseMaybe(args.heads)
				const mut = (d: any) => applyAutomerge(d, path, range, value)
				if (Array.isArray(heads) && heads.length) {
					h.changeAt(heads, mut)
				} else {
					h.change(mut)
				}
				// Return the affected container so the model can verify.
				const after = h.doc() as any
				let container: any = after
				for (const k of path) container = container == null ? container : container[k]
				let preview: string
				try {
					preview = JSON.stringify(container, null, 2)
				} catch {
					preview = String(container)
				}
				if (preview && preview.length > 4000)
					preview = preview.slice(0, 4000) + "\n…(truncated)"
				return (
					"OK — applied op to " +
					h.url +
					" at path " +
					JSON.stringify(path) +
					".\nValue at path now:\n" +
					preview
				)
			} else if (toolName === "find_text") {
				const url = args.url || focusedUrl()
				if (!url) return "Error: no url and no focused document."
				const query =
					typeof args.query === "string" ? args.query : String(args.query ?? "")
				if (!query) return "Error: find_text requires a non-empty `query`."
				let restrict: any = args.path
				if (typeof restrict === "string") {
					try {
						restrict = JSON.parse(restrict)
					} catch {
						restrict = undefined
					}
				}
				const h = await repo.find(url)
				const matches = findTextMatches(h.doc(), query, restrict)
				if (!matches.length) {
					return (
						"No matches for " +
						JSON.stringify(query) +
						(restrict ? " at " + JSON.stringify(restrict) : "") +
						". read_doc to see the exact current text."
					)
				}
				return (
					"Found " +
					matches.length +
					" match(es). Use start/end as an automerge_op range (or call replace_text):\n" +
					JSON.stringify(matches, null, 2)
				)
			} else if (toolName === "replace_text") {
				const url = args.url || focusedUrl()
				if (!url) return "Error: no url and no focused document."
				const find =
					typeof args.find === "string" ? args.find : String(args.find ?? "")
				if (!find) return "Error: replace_text requires a non-empty `find`."
				const replacement =
					typeof args.replace === "string"
						? args.replace
						: args.replace == null
							? ""
							: String(args.replace)
				let restrict: any = args.path
				if (typeof restrict === "string") {
					try {
						restrict = JSON.parse(restrict)
					} catch {
						restrict = undefined
					}
				}
				const h = await repo.find(url)
				const matches = findTextMatches(h.doc(), find, restrict)
				if (!matches.length) {
					return (
						"Error: " +
						JSON.stringify(find) +
						" not found" +
						(restrict ? " at " + JSON.stringify(restrict) : "") +
						". read_doc to check the exact current text (whitespace/newlines included)."
					)
				}
				let chosen: TextMatch
				const occ =
					args.occurrence != null ? parseInt(args.occurrence, 10) : NaN
				if (matches.length > 1) {
					if (!occ || Number.isNaN(occ)) {
						return (
							"Ambiguous — " +
							matches.length +
							" occurrences of " +
							JSON.stringify(find) +
							". Re-call with `occurrence` (1-based) or a `path`:\n" +
							JSON.stringify(matches, null, 2)
						)
					}
					if (occ < 1 || occ > matches.length) {
						return "Error: occurrence " + occ + " out of range (1.." + matches.length + ")."
					}
					chosen = matches[occ - 1]
				} else {
					chosen = matches[0]
				}
				h.change((d: any) =>
					applyAutomerge(d, chosen.path, [chosen.start, chosen.end], replacement)
				)
				let after: any = h.doc()
				for (const k of chosen.path)
					after = after == null ? after : after[k]
				let preview: string
				try {
					preview = typeof after === "string" ? after : JSON.stringify(after)
				} catch {
					preview = String(after)
				}
				if (preview && preview.length > 4000)
					preview = preview.slice(0, 4000) + "\n…(truncated)"
				return (
					"OK — replaced " +
					JSON.stringify(find) +
					" → " +
					JSON.stringify(replacement) +
					" at path " +
					JSON.stringify(chosen.path) +
					".\nField now:\n" +
					preview
				)
			} else if (toolName === "inspect_dom") {
				const sel = args.selector
				try {
					if (sel) {
						const els = Array.from(
							document.querySelectorAll(sel)
						) as HTMLElement[]
						if (!els.length) return "No elements match selector: " + sel
						return els
							.map((el) => el.outerHTML)
							.join("\n\n")
							.slice(0, 8000)
					}
					return (document.body?.outerHTML || "(empty)").slice(0, 8000)
				} catch (e: any) {
					return "inspect_dom error: " + (e?.message || String(e))
				}
			} else if (toolName === "eval_js") {
				const code = args.code || ""
				if (!code.trim()) return "Error: eval_js requires `code`."
				try {
					// indirect eval → runs in the page's global scope
					const result = (0, eval)(code)
					try {
						return result === undefined ? "undefined" : JSON.stringify(result)
					} catch {
						return String(result)
					}
				} catch (e: any) {
					return "eval error: " + (e?.message || String(e))
				}
			} else if (toolName === "edit_doc") {
				const h = await repo.find(args.url)
				let val: any = args.value
				if (typeof args.value === "string") {
					try {
						val = JSON.parse(args.value)
					} catch {
						val = args.value
					}
				}
				h.change((d: any) => {
					if (typeof val === "string" && typeof d[args.field] === "string") {
						updateText(d, [args.field], val)
					} else {
						d[args.field] = val
					}
				})
				const after = h.doc() as any
				const current = after?.[args.field]
				const preview =
					typeof current === "string"
						? "\nCurrent value of " + args.field + ":\n" + current
						: ""
				return "OK — set " + args.field + " on " + args.url + preview
			} else if (toolName === "splice_doc") {
				const h = await repo.find(args.url)
				const index = parseInt(args.index, 10)
				const deleteCount = parseInt(args.deleteCount || "0", 10)
				const insert = args.insert || ""
				h.change((d: any) => {
					splice(d, [args.field], index, deleteCount, insert)
				})
				const after = h.doc() as any
				const current = after?.[args.field]
				const preview =
					typeof current === "string"
						? "\nCurrent value of " + args.field + ":\n" + current
						: ""
				return (
					"OK — spliced " +
					args.field +
					" at " +
					index +
					" (deleted " +
					deleteCount +
					", inserted " +
					insert.length +
					" chars)" +
					preview
				)
			} else if (toolName === "inspect_iframe") {
				// Find pinned iframe in sidebar
				const targetUrl = args.url
				const iframes = document.querySelectorAll(
					".chat-sidebar-pinned-wrap iframe"
				) as NodeListOf<HTMLIFrameElement>
				for (const iframe of iframes) {
					if (targetUrl) {
						// Match by doc param in iframe src
						try {
							const hash = (iframe.src || "").split("#")[1] || ""
							const params = new URLSearchParams(hash)
							const docId = params.get("doc") || ""
							if (
								!targetUrl.includes(docId) &&
								docId !== targetUrl.replace(/^automerge:/, "")
							)
								continue
						} catch {
							continue
						}
					}
					try {
						const body = iframe.contentDocument?.body
						const errors: string[] = []
						const errorEls = body?.querySelectorAll(
							".error, [class*='error'], [class*='Error']"
						)
						if (errorEls) {
							for (const el of errorEls)
								errors.push(el.textContent?.slice(0, 500) || "")
						}
						let result =
							"DOM:\n" + (body?.innerHTML?.slice(0, 3000) || "(empty)")
						if (errors.length > 0) result += "\n\nErrors:\n" + errors.join("\n")
						return result
					} catch {
						return "DOM: (cross-origin, cannot access)"
					}
				}
				return (
					"No pinned iframe found. " +
					iframes.length +
					" iframes in sidebar total."
				)
			} else if (toolName === "eval_in_iframe") {
				const targetUrl = args.url
				const iframes = document.querySelectorAll(
					".chat-sidebar-pinned-wrap iframe"
				) as NodeListOf<HTMLIFrameElement>
				for (const iframe of iframes) {
					if (targetUrl) {
						try {
							const hash = (iframe.src || "").split("#")[1] || ""
							const params = new URLSearchParams(hash)
							const docId = params.get("doc") || ""
							if (
								!targetUrl.includes(docId) &&
								docId !== targetUrl.replace(/^automerge:/, "")
							)
								continue
						} catch {
							continue
						}
					}
					try {
						const result = iframe.contentWindow?.eval(args.code)
						return String(result) ?? "undefined"
					} catch (e: any) {
						return "eval error: " + e.message
					}
				}
				return (
					"No pinned iframe found. " +
					iframes.length +
					" iframes in sidebar total."
				)
			} else if (toolName === "create_doc") {
				let data: any = {}
				if (args.data && typeof args.data === "object") data = args.data
				else {
					try {
						data = JSON.parse(args.data)
					} catch {
						data = {title: args.data || "Untitled"}
					}
				}
				const created = await repo.create2(data)
				// Resolve through repo.find so that on a draft the new doc is forked
				// into this draft's clones — otherwise later edit_doc/read_doc (which
				// go through repo.find) operate on a fresh empty clone of the original
				// while our create2 data sits on the un-forked original.
				const h = await repo.find(created.url)
				return (
					"Created document: " + h.url + "\n" + JSON.stringify(h.doc(), null, 2)
				)
			} else if (toolName === "pin_tool") {
				const url = args.url
				if (!url) return "Error: url is required"
				const targetUrl = normalizeAutomergeUrl(url)
				const toolId = args.toolId || args.tool_id || undefined
				let name = args.name || "doc"
				let type = "unknown"
				try {
					const targetHandle = await repo.find(targetUrl)
					const targetDoc = targetHandle.doc() as any
					type = targetDoc?.["@patchwork"]?.type || type
					if (!args.name && targetDoc?.title) name = targetDoc.title
				} catch {}
				props.handle.change((d: any) => {
					if (!d.docs) d.docs = []
					const existing = d.docs.find((dl: any) => dl.url === targetUrl)
					if (existing) {
						existing.pin = toolId || true
						if (type !== "unknown") existing.type = type
						if (name) existing.name = name
					} else {
						d.docs.push({url: targetUrl, type, name, pin: toolId || true})
					}
				})
				setSidebarVisible(true)
				return (
					"OK — pinned " +
					targetUrl +
					" to the sidebar" +
					(toolId ? " with tool " + toolId : "")
				)
			} else if (toolName === "edit_tool") {
				const code = args.code || args.content || args.value || ""
				if (!code.trim()) {
					return "Error: edit_tool requires `code` (or `content`/`value`)."
				}

				const target = await resolveToolSourceFromArgs(repo, args)
				const sourceHandle = await repo.find(target.sourceUrl)
				sourceHandle.change((d: any) => {
					if (typeof d.content === "string") updateText(d, ["content"], code)
					else d.content = code
				})

				if (target.folderUrl) {
					const folderHandle = await repo.find(target.folderUrl)
					folderHandle.change((d: any) => {
						d.lastSyncAt = Date.now()
					})
					if ((window as any).patchwork?.modules?.loadModules) {
						await (window as any).patchwork.modules.loadModules([
							target.folderUrl,
						])
					}
				}

				const iframes = document.querySelectorAll(
					".chat-sidebar-pinned-wrap iframe"
				) as NodeListOf<HTMLIFrameElement>
				for (const iframe of iframes) reloadPreviewIframe(iframe)

				const updatedDoc = sourceHandle.doc() as any
				const updatedContent =
					typeof updatedDoc?.content === "string" ? updatedDoc.content : ""
				const linesCount = updatedContent
					? updatedContent.split("\n").length
					: 0

				return [
					"✅ Updated tool **" + target.toolName + "**.",
					"",
					"- toolId: " + target.toolId,
					"- source: " + target.sourceName,
					target.folderUrl ? "- reloaded: yes" : "- reloaded: source only",
					"- size: " +
						updatedContent.length +
						" chars, " +
						linesCount +
						" lines",
				].join("\n")
			}
			if (toolName === "define_tool") {
				const name = typeof args.name === "string" ? args.name.trim() : ""
				if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
					return "Error: define_tool needs a valid `name` (identifier chars only, e.g. word_count)."
				}
				const builtin = [...COMPUTER_TOOLS, ...CONTEXT_TOOLS].some(
					(t) => t.name === name
				)
				if (builtin) {
					return "Error: " + name + " is a built-in tool name — choose another."
				}
				const code = typeof args.code === "string" ? args.code : ""
				if (!code.trim()) {
					return "Error: define_tool needs `code` (a JavaScript function body)."
				}
				let parameters: any = args.parameters
				if (typeof parameters === "string") {
					try {
						parameters = JSON.parse(parameters)
					} catch {
						parameters = undefined
					}
				}
				if (!parameters || typeof parameters !== "object") {
					parameters = {type: "object", properties: {}}
				}
				const description =
					typeof args.description === "string" ? args.description : ""
				props.handle.change((d: any) => {
					if (!Array.isArray(d.computerCustomTools)) d.computerCustomTools = []
					const existing = d.computerCustomTools.find(
						(t: any) => t?.name === name
					)
					if (existing) {
						existing.description = description
						existing.parameters = parameters
						existing.code = code
					} else {
						d.computerCustomTools.push({name, description, parameters, code})
					}
				})
				return (
					"OK — defined tool `" +
					name +
					"`. It becomes available on your NEXT run (not this turn)."
				)
			}
			// A tool the computer defined for itself via define_tool — run its JS.
			const custom = (
				(props.handle.doc() as any)?.computerCustomTools || []
			).find((t: any) => t?.name === toolName)
			if (custom && typeof custom.code === "string") {
				try {
					const ctx = {
						repo,
						handle: props.handle,
						element: props.element,
						focusedUrl: focusedUrl(),
						applyAutomerge,
					}
					// eslint-disable-next-line no-new-func
					const fn = new Function(
						"args",
						"ctx",
						'"use strict";return (async()=>{' + custom.code + "\n})();"
					)
					const result = await fn(args, ctx)
					if (result === undefined) return "(tool ran; no return value)"
					try {
						return typeof result === "string"
							? result
							: JSON.stringify(result, null, 2)
					} catch {
						return String(result)
					}
				} catch (e: any) {
					return "custom tool error: " + (e?.message || String(e))
				}
			}
			return "Unknown tool: " + toolName
		} catch (e: any) {
			return "Tool error: " + e.message
		}
	}

	function extractDatatypeId(code: string): string | null {
		// Look for id in a patchwork:datatype plugin entry
		const dtMatch = code.match(
			/type:\s*["']patchwork:datatype["'][^}]*?id:\s*["']([^"']+)["']/
		)
		if (dtMatch) return dtMatch[1]
		// Fallback: first id: "..." in a plugins array
		const fallback = code.match(
			/plugins\s*=\s*\[[\s\S]*?id:\s*["']([^"']+)["']/
		)
		return fallback ? fallback[1] : null
	}

	async function createAndPinTool(code: string): Promise<any> {
		const repo = (props.element as any).repo
		const doc = props.handle.doc() as any

		// Extract the datatype ID from the code — this is what the instance doc type must match
		const datatypeId = extractDatatypeId(code)
		if (!datatypeId) {
			console.warn("[Chat] Could not extract datatype ID from code")
			return null
		}

		// Check for existing pinned tool to update
		const existingPinned = (doc?.docs || []).find((d: any) => d.pin)
		if (existingPinned) {
			try {
				const folderHandle = await repo.find(existingPinned.url)
				const folderDoc = folderHandle.doc()
				const suggestedUrl = folderDoc?.["@patchwork"]?.suggestedImportUrl
				if (suggestedUrl) {
					const toolFolder = await repo.find(suggestedUrl)
					const toolFolderDoc = toolFolder.doc()
					const jsEntry = toolFolderDoc?.docs?.find((d: any) =>
						d.name?.endsWith(".js")
					)
					if (jsEntry) {
						const existingDatatypeId = existingPinned.pin || existingPinned.type
						// If the LLM used a different datatype ID than the existing one, patch it
						let finalCode = code
						if (datatypeId !== existingDatatypeId) {
							finalCode = code.replace(
								new RegExp(
									"([\"'])" +
										datatypeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
										"\\1",
									"g"
								),
								'"' + existingDatatypeId + '"'
							)
						}
						const jsHandle = await repo.find(jsEntry.url)
						jsHandle.change((d: any) => {
							updateText(d, ["content"], finalCode)
						})
						toolFolder.change((d: any) => {
							d.lastSyncAt = Date.now()
						})
						if ((window as any).patchwork?.modules?.loadModules) {
							await (window as any).patchwork.modules.loadModules([
								suggestedUrl,
							])
						}
						// Reload iframe after update
						const iframes = document.querySelectorAll(
							".chat-sidebar-pinned-wrap iframe"
						) as NodeListOf<HTMLIFrameElement>
						for (const iframe of iframes) reloadPreviewIframe(iframe)
						return {
							toolName: existingPinned.name || existingDatatypeId,
							toolId: existingDatatypeId,
							updated: true,
						}
					}
				}
			} catch (e) {
				console.warn("[Chat] Could not update existing tool:", e)
			}
		}

		// Create new tool — use the IDs the LLM chose
		const encoder = new TextEncoder()
		const jsFileName = "tool.js"
		const jsHandle = await repo.create2({
			content: code,
			name: jsFileName,
			extension: ".js",
			mimeType: "application/javascript",
			"@patchwork": {type: "file"},
		})

		// Create package.json
		const pkgContent = encoder.encode(
			JSON.stringify(
				{
					name: "@patchwork/" + datatypeId,
					type: "module",
					main: jsFileName,
					exports: {".": jsFileName},
				},
				null,
				2
			)
		)
		const pkgHandle = await repo.create2({
			content: pkgContent,
			name: "package.json",
			extension: ".json",
			mimeType: "application/json",
			"@patchwork": {type: "file"},
		})

		const folderHandle = await repo.create2({
			title: datatypeId,
			docs: [
				{url: jsHandle.url, type: "application/javascript", name: jsFileName},
				{url: pkgHandle.url, type: "application/json", name: "package.json"},
			],
			lastSyncAt: Date.now(),
		})

		// Create instance doc — type must match the datatype id
		let instanceHandle = await repo.create2({
			title: datatypeId,
			"@patchwork": {type: datatypeId, suggestedImportUrl: folderHandle.url},
		})
		// Resolve through repo.find so that on a draft we write init() into the
		// same clone the pin/UI renders. (The overlay forks on repo.find; the
		// create2 handle is the un-forked original, so init()'ing it would leave
		// the displayed clone empty — the find<->create2 draft gotcha.)
		instanceHandle = await repo.find(instanceHandle.url)

		// Try to auto-initialize with datatype.init()
		try {
			const blob = new Blob([code], {type: "application/javascript"})
			const blobUrl = URL.createObjectURL(blob)
			const mod = await import(/* @vite-ignore */ blobUrl)
			URL.revokeObjectURL(blobUrl)
			const dt = mod.default?.init
				? mod.default
				: (Object.values(mod).find(
						(v: any) =>
							v &&
							typeof v === "object" &&
							typeof (v as any).init === "function"
					) as any)
			if (dt) {
				instanceHandle.change((d: any) => {
					dt.init(d)
				})
			}
		} catch (e) {
			console.warn("[Chat] Could not auto-init tool doc:", e)
		}

		// Pin it — pin value is the datatype id so we can match it for updates
		props.handle.change((d: any) => {
			if (!d.docs) d.docs = []
			d.docs.push({
				url: instanceHandle.url,
				type: datatypeId,
				name: datatypeId,
				pin: datatypeId,
			})
		})
		setSidebarVisible(true)

		// Load module
		if ((window as any).patchwork?.modules?.loadModules) {
			await (window as any).patchwork.modules.loadModules([folderHandle.url])
		}

		return {toolName: datatypeId, toolId: datatypeId, updated: false}
	}

	// ---- Context assembly ----
	async function assembleContext(): Promise<any[]> {
		const repo = (props.element as any).repo
		const doc = props.handle.doc() as any
		const msgs = doc?.messages || []
		const contextMessages: any[] = []

		const recent = msgs.slice(-50)

		// Find the latest context-clear marker and only include messages after it
		let startIdx = 0
		for (let i = recent.length - 1; i >= 0; i--) {
			const entry = recent[i]
			if (!entry?.ref || !entry?.url) continue
			try {
				const mh = await repo.find(entry.url)
				const msg = mh.doc() as any
				if (msg?.contextClear) {
					startIdx = i + 1
					break
				}
			} catch {}
		}

		for (let ri = startIdx; ri < recent.length; ri++) {
			const entry = recent[ri]
			if (!entry?.ref || !entry?.url) continue
			try {
				const mh = await repo.find(entry.url)
				const msg = mh.doc() as any
				if (!msg) continue
				let text = msg.text || ""
				const role = msg.isComputer ? "assistant" : "user"
				const prefix = msg.isComputer ? "" : `[${msg.name}] `

				// Include voice note transcription
				if (msg.voiceUrl) {
					try {
						const rh = await repo.find(msg.voiceUrl)
						let rd = rh.doc() as any
						if (rd?.transcription) {
							text += "\n[Voice note transcription: " + rd.transcription + "]"
						} else {
							// Trigger transcription and wait briefly for it
							const transcription = await new Promise<string | null>(
								resolve => {
									const timeout = setTimeout(() => resolve(null), 5000)
									transcribeVoiceNote(msg.voiceUrl, result => {
										clearTimeout(timeout)
										resolve(result)
									})
								}
							)
							if (transcription) {
								text += "\n[Voice note transcription: " + transcription + "]"
							} else {
								text +=
									"\n[Voice note attached, transcription not yet available]"
							}
						}
					} catch {}
				}

				contextMessages.push({
					role,
					content: msg.isComputer ? text : prefix + text,
				})
			} catch {}
		}

		// Add context info
		const logParts: string[] = []

		// Context tool: inject the FOCUSED document (url + heads + contents) so the
		// computer knows what it's editing without always having to read_doc first.
		if (isContext()) {
			const turl = props.targetDocUrl?.()
			if (turl) {
				try {
					const th = await repo.find(turl)
					const td = th.doc() as any
					let heads: any = []
					try {
						heads = th.heads()
					} catch {}
					let snap = ""
					try {
						snap = JSON.stringify(td, null, 2)
					} catch {
						snap = String(td)
					}
					if (snap.length > 8000) {
						snap =
							snap.slice(0, 8000) +
							"\n…(truncated — call read_doc for the full document)"
					}
					logParts.push(
						"Focused document (the document you are editing):\n" +
							"url=" +
							turl +
							"\nheads=" +
							JSON.stringify(heads) +
							"\ntype=" +
							(td?.["@patchwork"]?.type || "unknown") +
							"\ncontents:\n" +
							snap
					)
				} catch {}
			} else {
				logParts.push(
					"No document is currently focused. Ask the user to select one, or work from a url they give you."
				)
			}
		}

		// Chat shared files
		if (doc?.docs?.length > 0) {
			const fileList = doc.docs
				.map(
					(d: any) =>
						`- ${d.name} (${d.type || "unknown"}) url=${d.url}${d.pin ? " [PINNED]" : ""}`
				)
				.join("\n")
			logParts.push("Chat shared files:\n" + fileList)
		}

		// Pinned iframe status (DOM + errors)
		const iframeStatus = gatherPinnedIframeStatus()
		if (iframeStatus.length > 0) {
			let iframeContext = "Pinned tool iframes:\n"
			for (const s of iframeStatus) {
				iframeContext += "\n### " + s.name + "\n"
				if (s.errors.length > 0)
					iframeContext += "Errors:\n" + s.errors.join("\n") + "\n"
				if (s.domSnippet !== "(cross-origin)") {
					iframeContext += "DOM snippet:\n" + s.domSnippet.slice(0, 1500) + "\n"
				}
			}
			logParts.push(iframeContext)
		}

		// Feature-contributed context (e.g. the `call` bundle folds in its transcript).
		// The host stays agnostic: each active feature's loaded module may expose an
		// async `buildContext({repo, doc})` returning a string to append.
		for (const f of loadedFeatures()) {
			if (typeof (f as any).buildContext !== "function") continue
			try {
				const part = await (f as any).buildContext({repo, doc})
				if (part) logParts.push(part)
			} catch {}
		}

		if (logParts.length > 0) {
			contextMessages.push({
				role: "user",
				content: "[Context]\n" + logParts.join("\n\n"),
			})
		}

		return contextMessages
	}

	function sendComputerMessage(text: string, replyTo?: string, opts?: any) {
		const repo = (props.element as any).repo
		if (!repo) return
		const msgData: any = {
			id: generateId(),
			name: computerName(),
			text: text || "",
			timestamp: Date.now(),
			isComputer: true,
			font: "monospace",
		}
		if (replyTo) msgData.replyTo = replyTo
		if (opts?.embeds) msgData.embeds = opts.embeds
		if (opts?.contextClear) msgData.contextClear = true
		repo.create2(msgData).then((msgHandle: any) => {
			props.handle.change((d: any) => {
				if (!d.messages) d.messages = []
				d.messages.push({
					ref: true,
					url: msgHandle.url,
					timestamp: msgData.timestamp,
				})
			})
		})
	}

	async function handleComputerCommand(sub: string) {
		if (sub === "kick") {
			if (!computerActive()) {
				sendComputerMessage("computer is not active.")
				return
			}
			setComputerActive(false)
			setComputerAutoMode(false)
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval)
				heartbeatInterval = null
			}
			if (computerListenerCleanup) {
				computerListenerCleanup()
				computerListenerCleanup = null
			}
			computerListenerActive = false
			props.handle.change((d: any) => {
				d.hasComputer = false
				delete d.computerInstanceId
				delete d.computerHeartbeat
				delete d.computerOwner
				delete d.computerModel
			})
			sendComputerMessage("computer has left the chat.")
			return
		}
		if (sub === "nosey" || sub === "auto") {
			if (!computerActive()) {
				sendComputerMessage(
					"computer is not active. Use /computer invite first."
				)
				return
			}
			setComputerAutoMode(!computerAutoMode())
			sendComputerMessage(
				"Auto-respond mode: " + (computerAutoMode() ? "ON" : "OFF")
			)
			return
		}
		if (sub === "clear") {
			if (!computerActive()) {
				sendComputerMessage("computer is not active.")
				return
			}
			sendComputerMessage(
				"context cleared. i'll only consider messages from this point forward.",
				undefined,
				{contextClear: true}
			)
			return
		}
		if (sub === "owner" || sub === "who") {
			const d = props.handle.doc() as any
			if (!d?.hasComputer) {
				sendComputerMessage(
					"computer isn't active — nobody owns it. /computer invite to add it."
				)
				return
			}
			const owner = d.computerOwner
			const mine = isComputerHost()
			sendComputerMessage(
				owner
					? "computer is owned by " + owner + (mine ? " (that's you)" : "") + "."
					: "computer is active but unclaimed" +
							(mine ? " — and you're the host" : "") +
							". /computer own to claim it."
			)
			return
		}
		if (sub === "own" || sub === "pwn") {
			const prevOwner = (props.handle.doc() as any)?.computerOwner
			const me = ownerName()
			if (isComputerHost() && computerActive() && prevOwner && prevOwner === me) {
				sendComputerMessage("you already own computer.")
				return
			}
			setComputerActive(true)
			claimComputerHost()
			startComputerListener()
			const verb = sub === "pwn" ? "pwned" : "took ownership of"
			sendComputerMessage(
				(me || "you") +
					" " +
					verb +
					" computer" +
					(prevOwner && prevOwner !== me ? " (was " + prevOwner + ")" : "") +
					"."
			)
			return
		}
		if (sub === "model" || sub === "models") {
			void openModelPicker()
			return
		}
		// Default: invite — claim this tab as the computer host
		if (computerActive()) {
			sendComputerMessage("computer is already here!")
			return
		}
		setComputerActive(true)
		claimComputerHost()
		sendComputerMessage(
			[
				"hello! i'm computer, a computer program. mention @computer or reply to my messages and i'll respond.",
				"",
				"• /model — pick the model or provider (opens the config panel)",
				"• /computer nosey — make me respond to everything",
				"• /computer owner — see who's hosting me; /computer own to take over",
				"• /computer kick — send me away",
			].join("\n")
		)
		startComputerListener()
	}

	function claimComputerHost() {
		props.handle.change((d: any) => {
			d.hasComputer = true
			d.computerInstanceId = myInstanceId
			d.computerHeartbeat = Date.now()
			const n = ownerName()
			if (n) d.computerOwner = n
			const m = modelLabel()
			if (m) d.computerModel = m
		})
		// We're the host now, stop watching for staleness
		if (stalenessWatchInterval) {
			clearInterval(stalenessWatchInterval)
			stalenessWatchInterval = null
		}
		if (heartbeatInterval) clearInterval(heartbeatInterval)
		heartbeatInterval = setInterval(() => {
			const d = props.handle.doc() as any
			if (d?.computerInstanceId === myInstanceId) {
				props.handle.change((dd: any) => {
					dd.computerHeartbeat = Date.now()
				})
			}
		}, HEARTBEAT_INTERVAL)
	}

	function isComputerHost(): boolean {
		const d = props.handle.doc() as any
		return d?.computerInstanceId === myInstanceId
	}

	function startComputerListener() {
		if (computerListenerActive) return
		computerListenerActive = true
		let lastCheckedIdx = (props.handle.doc() as any)?.messages?.length || 0
		const pendingQueue: string[] = []
		let processing = false

		async function processQueue() {
			if (processing) return
			processing = true
			const repo = (props.element as any).repo
			try {
				while (pendingQueue.length > 0) {
					const url = pendingQueue.shift()!
					if (computerRespondedToIds.has(url) || !repo) continue
					try {
						const mh = await repo.find(url)
						const msg = mh.doc() as any
						if (
							!msg ||
							msg.name?.toLowerCase() === "computer" ||
							msg.isComputer
						) {
							console.log(
								"[Computer] skipping message from",
								msg?.name,
								"isComputer=" + msg?.isComputer
							)
							continue
						}
						if (computerRespondedToIds.has(url)) continue

						// Check if already claimed by another instance
						if (msg.computerClaimedBy) {
							computerRespondedToIds.add(url)
							continue
						}

						// Check if this is a reply to a Computer message
						let isReplyToComputer = false
						if (msg.replyTo) {
							const allMsgs = (props.handle.doc() as any)?.messages || []
							for (const entry of allMsgs) {
								if (!entry?.ref || !entry?.url) continue
								try {
									const rh = await repo.find(entry.url)
									const rd = rh.doc() as any
									if (
										rd?.id === msg.replyTo &&
										(rd?.isComputer || rd?.name?.toLowerCase() === "computer")
									) {
										isReplyToComputer = true
										break
									}
								} catch {}
							}
						}
						let lowerText = msg.text?.toLowerCase() || ""
						// Check voice note transcription for computer mentions
						if (msg.voiceUrl) {
							try {
								const rh = await repo.find(msg.voiceUrl)
								const rd = rh.doc() as any
								if (rd?.transcription) {
									lowerText += " " + rd.transcription.toLowerCase()
								} else {
									// Transcription not ready — watch for it and re-queue
									transcribeVoiceNote(msg.voiceUrl)
									const voiceUrl = url
									const cb = () => {
										const fresh = rh.doc() as any
										if (fresh?.transcription) {
											rh.off("change", cb)
											if (!computerRespondedToIds.has(voiceUrl)) {
												pendingQueue.push(voiceUrl)
												processQueue()
											}
										}
									}
									rh.on("change", cb)
									setTimeout(() => rh.off("change", cb), 30000)
									continue // skip for now, will re-check when transcription arrives
								}
							} catch {}
						}
						const mentionsComputer =
							lowerText.includes("@computer") ||
							lowerText.includes("@momcomputer") ||
							lowerText.includes("@momputer") ||
							lowerText.includes("computer,") ||
							lowerText.includes("computer.") ||
							(msg.voiceUrl && lowerText.trimStart().startsWith("computer"))
						const shouldRespond =
							computerAutoMode() || mentionsComputer || isReplyToComputer
						if (shouldRespond) {
							// Signal to other tabs that we're handling this
							props.handle.broadcast({
								type: "computer-responding",
								from: myInstanceId,
							})
							// Claim this message before responding
							mh.change((d: any) => {
								d.computerClaimedBy = myInstanceId
							})
							// Brief delay for CRDT sync
							await new Promise(r => setTimeout(r, 300))
							// Re-check claim after sync
							const fresh = mh.doc() as any
							if (fresh.computerClaimedBy !== myInstanceId) {
								computerRespondedToIds.add(url)
								continue // Another instance won
							}
							computerRespondedToIds.add(url)
							console.log("[Computer] responding to:", msg.text?.slice(0, 50))
							try {
								await respondToUser(msg)
							} catch (e) {
								console.warn("[Computer] respondToUser error:", e)
							}
							console.log(
								"[Computer] finished responding, queue has",
								pendingQueue.length,
								"items"
							)
						} else {
							console.log(
								"[Computer] not responding to:",
								msg.text?.slice(0, 50),
								"shouldRespond=" + shouldRespond
							)
						}
					} catch (e) {
						console.warn("[Chat] computer resolve:", e)
					}
				}
			} finally {
				processing = false
			}
			// Items may have arrived while we were processing — drain again
			if (pendingQueue.length > 0) {
				console.log(
					"[Computer] draining",
					pendingQueue.length,
					"remaining items"
				)
				processQueue()
			}
		}

		const onDocChange = () => {
			if (!computerActive() || !isComputerHost()) return
			const d = props.handle.doc() as any
			if (!d?.messages) return
			const msgs = d.messages
			if (msgs.length <= lastCheckedIdx) {
				lastCheckedIdx = msgs.length
				return
			}
			let queued = 0
			for (let i = lastCheckedIdx; i < msgs.length; i++) {
				const entry = msgs[i]
				if (!entry?.ref || !entry?.url) continue
				if (computerRespondedToIds.has(entry.url)) continue
				pendingQueue.push(entry.url)
				queued++
			}
			lastCheckedIdx = msgs.length
			if (queued > 0) {
				console.log(
					"[Computer] onChange: queued " +
						queued +
						" new msgs" +
						(processing ? " (will process after current response)" : "")
				)
				processQueue()
			}
		}
		props.handle.on("change", onDocChange)
		computerListenerCleanup = () => {
			props.handle.off("change", onDocChange)
		}
	}

	function gatherPinnedIframeStatus(): {
		name: string
		url: string
		errors: string[]
		domSnippet: string
	}[] {
		const results: {
			name: string
			url: string
			errors: string[]
			domSnippet: string
		}[] = []
		const pinnedWraps = document.querySelectorAll(".chat-sidebar-pinned-wrap")
		for (const wrap of pinnedWraps) {
			const iframe = wrap.querySelector("iframe") as HTMLIFrameElement | null
			const title = iframe?.title || "unknown"
			// Extract URL from iframe src params
			let docUrl = ""
			try {
				const src = iframe?.src || ""
				const hash = src.split("#")[1] || ""
				const params = new URLSearchParams(hash)
				docUrl = params.get("doc") || ""
			} catch {}
			if (!iframe) {
				results.push({
					name: title,
					url: docUrl,
					errors: ["No iframe found"],
					domSnippet: "(empty)",
				})
				continue
			}
			try {
				const iframeDoc = iframe.contentDocument
				const body = iframeDoc?.body
				const domSnippet = body?.innerHTML || "(empty)"
				const errors: string[] = []
				const errorEls = body?.querySelectorAll(
					".error, [class*='error'], [class*='Error']"
				)
				if (errorEls) {
					for (const el of errorEls) {
						errors.push(el.textContent?.slice(0, 500) || "")
					}
				}
				// Also check for console errors captured on the window
				try {
					const win = iframe.contentWindow as any
					if (win?.__chatErrors) {
						for (const err of win.__chatErrors) errors.push(String(err))
					}
				} catch {}
				results.push({
					name: title,
					url: docUrl,
					errors,
					domSnippet: domSnippet.slice(0, 2000),
				})
			} catch {
				results.push({
					name: title,
					url: docUrl,
					errors: ["Cross-origin, cannot access"],
					domSnippet: "(cross-origin)",
				})
			}
		}
		return results
	}

	async function respondToUser(userMsg: any) {
		const repo = (props.element as any).repo
		if (!repo || computerResponding) return
		computerResponding = true

		const abortController = new AbortController()
		setComputerAbort(abortController)
		// Inactivity timeout: abort if no tokens received for 30s
		let inactivityTimer: any = null
		const INACTIVITY_TIMEOUT = 90000
		function resetInactivityTimer() {
			if (inactivityTimer) clearTimeout(inactivityTimer)
			inactivityTimer = setTimeout(() => {
				console.warn(
					"[Computer] aborting: no output for " +
						INACTIVITY_TIMEOUT / 1000 +
						"s"
				)
				abortController.abort()
			}, INACTIVITY_TIMEOUT)
		}
		resetInactivityTimer()

		let currentStreamHandle: any = null
		let tokenThrottleTimer: any = null

		try {
			const context = await assembleContext()
			resetInactivityTimer()
			const isMomputer = (userMsg.text || "")
				.toLowerCase()
				.includes("@momputer")
			// Generate a tool name for this response — the LLM uses it if it builds a tool
			const suggestedToolName = randomToolName()
			// The addenda go on every variant of the base prompt.
			const base = computerSystemForFrame()
			const addenda =
				'\n\n## Your Tool ID\nIf you build a patchwork tool in this response, use `"' +
				suggestedToolName +
				'"` as the id for both the datatype and tool plugins, and in supportedDatatypes.' +
				(isMomputer
					? '\n\n## Special Mode: Momputer\nThe user addressed you as @momputer. Be warm, nurturing, and motherly in your response. Use gentle encouragement, express care and concern, and be supportive like a loving mom would be. You can use pet names like "sweetie", "honey", "dear", etc. Still be helpful and knowledgeable, but with a cozy maternal energy.'
					: "")
			const systemPrompt: string | Record<string, string> =
				typeof base === "string"
					? base + addenda
					: Object.fromEntries(
							Object.entries(base).map(([k, v]) => [k, v + addenda])
					  )
			const messages = [...context, {role: "user", content: userMsg.text}]

			// Create streaming message — use `let` so we can reassign
			const streamMsgData: any = {
				id: generateId(),
				name: (isMomputer ? "momputer" : "computer") + modelSuffix(),
				text: "",
				timestamp: Date.now(),
				isComputer: true,
				font: isMomputer ? "Comic Sans MS, cursive" : "monospace",
				streaming: true,
				replyTo: userMsg.id,
			}
			currentStreamHandle = await repo.create2(streamMsgData)
			// Resolve through repo.find so that on a draft our streaming writes
			// target the same clone the UI subscribes to when it renders this ref.
			// (The overlay forks the doc on repo.find; the create2 handle is the
			// un-forked original, so writing to it leaves the displayed clone empty.)
			currentStreamHandle = await repo.find(currentStreamHandle.url)
			props.handle.change((dd: any) => {
				if (!dd.messages) dd.messages = []
				dd.messages.push({
					ref: true,
					url: currentStreamHandle.url,
					timestamp: streamMsgData.timestamp,
				})
			})
			let latestTokenText = ""
			let showingStatus = false
			function onToken(fullText: string) {
				showingStatus = false
				setLlmStatus("")
				resetInactivityTimer()
				latestTokenText = fullText.replace(/^\[Computer\]\s*/i, "")
				if (!tokenThrottleTimer) {
					tokenThrottleTimer = setTimeout(() => {
						tokenThrottleTimer = null
						currentStreamHandle.change((d: any) => {
							d.text = latestTokenText
						})
					}, 200)
				}
			}
			function onStatus(status: string) {
				if (!status || latestTokenText) return // don't overwrite real tokens
				showingStatus = true
				resetInactivityTimer()
				// The computer computes — it doesn't "think". Rewrite the lib's
				// anthropomorphic status text before showing it.
				setLlmStatus(status.replace(/think(ing)?/gi, "computing"))
			}

			const MAX_TOOL_ROUNDS = 5
			let madeChanges = false
			let completedResponse = false
			for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
				const gen = await generateLLM(
					messages,
					onToken,
					abortController.signal,
					onStatus,
					systemPrompt,
					enabledComputerTools(),
					noteModelLabel
				)
				resetInactivityTimer()
				if (tokenThrottleTimer) {
					clearTimeout(tokenThrottleTimer)
					tokenThrottleTimer = null
				}
				let response = (gen.text || "").replace(/^\[Computer\]\s*/i, "")
				// Real tool calls: structured from the provider (native function
				// calling), or parsed from <tool_call> text by the worker.
				const calls = gen.toolCalls ?? []
				// Strip any tool-call markup from the text we display (local models
				// emit <tool_call>…</tool_call> inline; that's plumbing, not prose).
				const visible = response
					.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
					.replace(/```tool[-_]?call[\s\S]*?```/g, "")
					.trim()
				const parsed = parseRichBlocks(visible)

				const hasPatchworkTool = parsed.blocks.some(
					(b: any) => b.type === "patchwork-tool"
				)

				if (calls.length > 0 || hasPatchworkTool) {
					// If the LLM wrote text that ends with a question, it's asking the user.
					// Finalize this message and stop looping — don't feed tool results as if they're the answer.
					const trimmedText = parsed.text.trim()
					const endsWithQuestion =
						trimmedText.length > 0 &&
						(trimmedText.endsWith("?") ||
							/\b(what|which|how|should|would|do you|can you|could you|shall|prefer)\b/i.test(
								trimmedText.slice(-200)
							))
					// Explicit ask_user tool call — treated like a question: post it and
					// end the turn (the reply comes back as a fresh user message).
					const askCall = calls.find((c: any) => c.name === "ask_user")

					// Process output blocks (patchwork-tool, file, embed, image) — tool
					// calls are structured, so parsed.blocks are all output blocks.
					const partial = {blocks: parsed.blocks, text: parsed.text}
					const {text, opts} = await processRichBlocks(partial)
					if (hasPatchworkTool) madeChanges = true

					// Store rich blocks for UI display: tool-call cards synthesized from
					// the structured calls, plus any
					// patchwork-tool output blocks.
					const displayBlocks = [
						...calls.map((c: any) => ({
							type: "tool-call",
							content: renderCallText(c),
							meta: "",
						})),
						...parsed.blocks
							.filter((b: any) => b.type === "patchwork-tool")
							.map((b: any) => ({
								type: b.type,
								content: b.content,
								meta: b.meta || "",
							})),
					]

					currentStreamHandle.change((d: any) => {
						d.text = text || ""
						d.streaming = false
						if (opts?.embeds) d.embeds = opts.embeds
						if (displayBlocks.length > 0) {
							if (!d.richBlocks) d.richBlocks = []
							for (const bl of displayBlocks) d.richBlocks.push(bl)
						}
						// ask_user: surface the question as this message's text + render
						// its options as clickable quick-reply buttons.
						if (askCall) {
							const q =
								typeof askCall.args?.question === "string"
									? askCall.args.question
									: ""
							d.text = (text ? text + "\n\n" : "") + q
							let o: any = askCall.args?.options
							if (typeof o === "string") {
								try {
									o = JSON.parse(o)
								} catch {
									o = undefined
								}
							}
							if (Array.isArray(o) && o.length) {
								d.quickReplies = o.map((x: any) => String(x))
							}
						}
					})

					// If asking a question (prose or the ask_user tool), stop here —
					// don't loop; the answer arrives as a new user message.
					if (endsWithQuestion || askCall) {
						// Run any real side-effecting tool calls (but ask_user is
						// display-only — it's already been rendered above).
						for (const c of calls) {
							if (c.name === "ask_user") continue
							await runToolByName(c.name, c.args)
						}
						completedResponse = true
						break
					}

					// Execute tool calls and store results
					let toolResults = ""
					for (const c of calls) {
						const result = await runToolByName(c.name, c.args)
						resetInactivityTimer()
						toolResults +=
							"\n[Tool result for " + c.name + "]\n" + result + "\n"
						// Store result on the corresponding rich block
						currentStreamHandle.change((d: any) => {
							if (d.richBlocks) {
								const matching = [...d.richBlocks]
									.reverse()
									.find((b: any) => b.type === "tool-call" && !b.result)
								if (matching) matching.result = result.slice(0, 2000)
							}
						})
					}

					// Self-check: after making changes, check pinned iframes for errors
					let needsNextRound = calls.length > 0
					if (madeChanges) {
						await new Promise(r => setTimeout(r, 2000))
						resetInactivityTimer()
						const status = gatherPinnedIframeStatus()
						const hasErrors = status.some(s => s.errors.length > 0)
						const isEmpty = status.some(
							s => s.domSnippet === "(empty)" || s.domSnippet.trim().length < 10
						)

						if (hasErrors || isEmpty) {
							// Try reloading iframes if empty
							if (isEmpty) {
								const iframes = document.querySelectorAll(
									".chat-sidebar-pinned-wrap iframe"
								) as NodeListOf<HTMLIFrameElement>
								for (const iframe of iframes) reloadPreviewIframe(iframe)
								await new Promise(r => setTimeout(r, 2500))
								resetInactivityTimer()
							}

							const freshStatus = gatherPinnedIframeStatus()
							const stillBroken = freshStatus.some(
								s =>
									s.errors.length > 0 ||
									s.domSnippet === "(empty)" ||
									s.domSnippet.trim().length < 10
							)

							if (stillBroken) {
								let selfCheck =
									"[Self-check] After your changes, I inspected the pinned iframes:\n\n"
								for (const s of freshStatus) {
									selfCheck += "### " + s.name + "\n"
									if (s.errors.length > 0)
										selfCheck += "Errors:\n" + s.errors.join("\n") + "\n"
									if (
										s.domSnippet === "(empty)" ||
										s.domSnippet.trim().length < 10
									) {
										selfCheck +=
											"DOM is empty or nearly empty \u2014 the tool may not be rendering.\n"
									} else {
										selfCheck +=
											"DOM snippet:\n" + s.domSnippet.slice(0, 1500) + "\n"
									}
									selfCheck += "\n"
								}
								selfCheck +=
									"Please fix the issues. If there are errors, update the tool code. Output a ```patchwork-tool block with the corrected code."
								messages.push({role: "assistant", content: response})
								messages.push({role: "user", content: selfCheck})
								madeChanges = false
								needsNextRound = true
							}
						}
					}

					if (needsNextRound) {
						if (calls.length > 0) {
							messages.push({role: "assistant", content: response})
							messages.push({
								role: "user",
								content: "[Tool results]\n" + toolResults,
							})
						}
						// Create new streaming message for next round
						const nextMsgData: any = {
							id: generateId(),
							name: "computer",
							text: "",
							timestamp: Date.now(),
							isComputer: true,
							font: "monospace",
							streaming: true,
						}
						currentStreamHandle = await repo.create2(nextMsgData)
						// See note above: resolve via repo.find so streaming writes
						// hit the same (possibly draft-cloned) handle the UI renders.
						currentStreamHandle = await repo.find(currentStreamHandle.url)
						props.handle.change((dd: any) => {
							if (!dd.messages) dd.messages = []
							dd.messages.push({
								ref: true,
								url: currentStreamHandle.url,
								timestamp: nextMsgData.timestamp,
							})
						})
						continue
					}

					// No more rounds needed — done
					completedResponse = true
					break
				}

				// No tool calls or patchwork-tool — finalize with plain text
				const finalDisplayBlocks = parsed.blocks
					.filter((b: any) => b.type === "patchwork-tool")
					.map((b: any) => ({
						type: b.type,
						content: b.content,
						meta: b.meta || "",
					}))
				if (parsed.blocks.length > 0) {
					const {text, opts} = await processRichBlocks(parsed)
					currentStreamHandle.change((d: any) => {
						d.text = text || "Here you go!"
						d.streaming = false
						if (opts?.embeds) d.embeds = opts.embeds
						if (finalDisplayBlocks.length > 0) {
							if (!d.richBlocks) d.richBlocks = []
							for (const bl of finalDisplayBlocks) d.richBlocks.push(bl)
						}
					})
				} else {
					currentStreamHandle.change((d: any) => {
						d.text = response
						d.streaming = false
					})
				}
				completedResponse = true
				break
			}

			if (!completedResponse && currentStreamHandle) {
				currentStreamHandle.change((d: any) => {
					if (!d.text || !d.text.trim()) {
						d.text =
							"I ran multiple tool steps and need one more message to finish. Please prompt me again and I will continue from current state."
					}
					d.streaming = false
				})
			}
		} catch (err: any) {
			if (currentStreamHandle) {
				try {
					currentStreamHandle.change((d: any) => {
						const prefix = (d.text || "").trim()
						d.text = prefix
							? prefix +
								"\n\nI hit an error while running tools: " +
								err.message
							: "Sorry, I hit an error while running tools: " + err.message
						d.streaming = false
					})
				} catch {}
			}
		} finally {
			setComputerAbort(null)
			if (inactivityTimer) clearTimeout(inactivityTimer)
			if (tokenThrottleTimer) clearTimeout(tokenThrottleTimer)
			// Always ensure streaming is cleared on the final message
			if (currentStreamHandle) {
				try {
					const finalDoc = currentStreamHandle.doc() as any
					if (finalDoc?.streaming) {
						currentStreamHandle.change((d: any) => {
							d.streaming = false
						})
					}
				} catch {}
			}
			computerResponding = false
			setLlmStatus("")
		}
	}

	// Non-host tabs watch for @computer messages going unanswered
	let watchMsgCount = 0
	function onDocChangeWatchdog() {
		if (isComputerHost()) return // host handles its own responses
		const d = props.handle.doc() as any
		if (!d?.hasComputer || !d?.messages) return
		const msgs = d.messages
		if (msgs.length <= watchMsgCount) {
			watchMsgCount = msgs.length
			return
		}
		// Check new messages for @computer mentions
		const repo = (props.element as any).repo
		if (!repo) return
		for (let i = watchMsgCount; i < msgs.length; i++) {
			const entry = msgs[i]
			if (!entry?.url) continue
			repo
				.find(entry.url)
				.then((mh: any) => {
					const msg = mh.doc()
					if (!msg || msg.name?.toLowerCase() === "computer" || msg.isComputer)
						return
					const lowerText = msg.text?.toLowerCase() || ""
					const mentionsComputer =
						lowerText.includes("@computer") ||
						lowerText.includes("@momcomputer") ||
						lowerText.includes("@momputer")
					if (mentionsComputer || computerAutoMode()) {
						watchForResponse()
					}
				})
				.catch(() => {})
		}
		watchMsgCount = msgs.length
	}

	// Check if computer was previously active — ping to verify host is alive
	onMount(() => {
		if (!has("computer")) return // the minimal `chat` tool has no Computer
		props.handle.on("ephemeral-message", handleComputerEphemeral)
		props.handle.on("change", onDocChangeWatchdog)
		watchMsgCount = (props.handle.doc() as any)?.messages?.length || 0

		const d = props.handle.doc() as any
		if (d?.hasComputer) {
			setComputerActive(true)
			const heartbeat = d.computerHeartbeat || 0
			const instanceId = d.computerInstanceId
			if (!instanceId || Date.now() - heartbeat > STALE_THRESHOLD) {
				// Previous host is obviously gone, claim immediately
				claimComputerHost()
				startComputerListener()
			} else {
				// Another host might be alive — ping to verify
				// Start listener immediately so we don't miss messages during ping wait
				claimComputerHost()
				startComputerListener()
				pingComputerHost().then(alive => {
					if (alive && !isComputerHost()) {
						// Another tab answered and is the real host — stand down
						// (they would have reclaimed via their heartbeat)
						startStalenessWatch()
					}
				})
			}
		}
	})

	// Watch for the current computer host going stale and auto-claim
	function startStalenessWatch() {
		if (stalenessWatchInterval) return
		stalenessWatchInterval = setInterval(() => {
			const d = props.handle.doc() as any
			if (!d?.hasComputer) {
				clearInterval(stalenessWatchInterval)
				stalenessWatchInterval = null
				return
			}
			// If we're already the host, no need to watch
			if (d.computerInstanceId === myInstanceId) {
				clearInterval(stalenessWatchInterval)
				stalenessWatchInterval = null
				return
			}
			const heartbeat = d.computerHeartbeat || 0
			if (Date.now() - heartbeat > STALE_THRESHOLD) {
				clearInterval(stalenessWatchInterval)
				stalenessWatchInterval = null
				claimComputerHost()
				startComputerListener()
			}
		}, HEARTBEAT_INTERVAL)
	}

	// Ping/pong liveness: actively verify the computer host is alive
	let pingResolve: ((alive: boolean) => void) | null = null

	function pingComputerHost(): Promise<boolean> {
		return new Promise(resolve => {
			pingResolve = resolve
			props.handle.broadcast({type: "computer-ping", from: myInstanceId})
			setTimeout(() => {
				if (pingResolve === resolve) {
					pingResolve = null
					resolve(false)
				}
			}, PING_TIMEOUT)
		})
	}

	function handleComputerEphemeral(data: {message: any}) {
		const msg = data.message
		if (!msg || typeof msg !== "object") return

		// Host responds to pings
		if (
			msg.type === "computer-ping" &&
			msg.from !== myInstanceId &&
			isComputerHost() &&
			computerListenerActive
		) {
			props.handle.broadcast({type: "computer-pong", from: myInstanceId})
		}

		// Non-host receives pong — the host is alive
		if (
			msg.type === "computer-pong" &&
			msg.from !== myInstanceId &&
			pingResolve
		) {
			const resolve = pingResolve
			pingResolve = null
			resolve(true)
		}

		// Watch for @computer messages going unanswered (any non-host tab monitors this)
		if (msg.type === "computer-responding" && msg.from !== myInstanceId) {
			// The host signalled it's handling a message — cancel any response watchdog
			if (responseWatchdog) {
				clearTimeout(responseWatchdog)
				responseWatchdog = null
			}
		}
	}

	// Response watchdog: if an @computer message isn't picked up, reclaim
	let responseWatchdog: any = null

	function watchForResponse() {
		if (isComputerHost()) return // we're the host, we'll handle it
		if (responseWatchdog) clearTimeout(responseWatchdog)
		responseWatchdog = setTimeout(async () => {
			responseWatchdog = null
			const d = props.handle.doc() as any
			if (!d?.hasComputer || d.computerInstanceId === myInstanceId) return
			// Ping to verify — maybe the host is just slow
			const alive = await pingComputerHost()
			if (!alive) {
				claimComputerHost()
				startComputerListener()
			}
		}, RESPONSE_TIMEOUT)
	}

	onCleanup(() => {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval)
			heartbeatInterval = null
		}
		if (stalenessWatchInterval) {
			clearInterval(stalenessWatchInterval)
			stalenessWatchInterval = null
		}
		if (computerListenerCleanup) {
			computerListenerCleanup()
			computerListenerCleanup = null
		}
		if (responseWatchdog) {
			clearTimeout(responseWatchdog)
			responseWatchdog = null
		}
		props.handle.off("ephemeral-message", handleComputerEphemeral)
		props.handle.off("change", onDocChangeWatchdog)
	})

	// ---- Lightbox ----
	const [lightboxSrc, setLightboxSrc] = createSignal<string | null>(null)
	const [lightboxType, setLightboxType] = createSignal<"image" | "video">(
		"image"
	)

	function openLightbox(src: string, type: "image" | "video" = "image") {
		setLightboxSrc(src)
		setLightboxType(type)
	}

	// ---- Pin ----
	function handlePinCommand(arg: string) {
		if (!arg) return

		// Try as automerge URL
		if (arg.startsWith("automerge:")) {
			pinDoc(arg as AutomergeUrl, undefined, arg.slice(0, 20) + "...")
			return
		}

		// Try as tiny patchwork URL
		const tinyMatch = arg.match(
			/https?:\/\/tiny\.patchwork\.inkandswitch\.com\/#[^\s]+/
		)
		if (tinyMatch) {
			try {
				const parsed = new URL(tinyMatch[0])
				const params = new URLSearchParams(parsed.hash.slice(1))
				const docId = params.get("doc")
				if (docId) {
					const docUrl = "automerge:" + docId
					const toolId = params.get("tool") || undefined
					const title = params.get("title")
						? decodeURIComponent(params.get("title")!.replace(/\+/g, " "))
						: docId.slice(0, 8) + "..."
					pinDoc(docUrl as AutomergeUrl, toolId, title)
					return
				}
			} catch {}
		}
	}

	// `/plugin` — `ls` (or no arg) opens the panel; `load`/`unload <id>` mutate the
	// document's `plugins` array directly.
	function handlePluginCommand(arg: string) {
		const parts = arg.trim().split(/\s+/).filter(Boolean)
		const sub = (parts[0] || "").toLowerCase()
		const id = parts[1]
		if (sub === "load" || sub === "add" || sub === "enable") {
			if (id) setPluginEnabled(id, true)
			else setShowPluginPanel(true)
			return
		}
		if (sub === "unload" || sub === "remove" || sub === "disable") {
			if (id) setPluginEnabled(id, false)
			else setShowPluginPanel(true)
			return
		}
		// "ls" | "list" | empty | anything else → open the panel
		setShowPluginPanel(true)
	}

	function setPluginEnabled(id: string, on: boolean) {
		props.handle.change((d: any) => {
			if (!Array.isArray(d.plugins)) d.plugins = []
			const i = d.plugins.indexOf(id)
			if (on && i < 0) d.plugins.push(id)
			if (!on && i >= 0) d.plugins.splice(i, 1)
		})
	}

	function pinDoc(url: AutomergeUrl, toolId?: string, name?: string) {
		props.handle.change((d: any) => {
			if (!d.docs) d.docs = []
			const existing = d.docs.find((dl: any) => dl.url === url)
			if (existing) {
				if (existing.pin) {
					existing.pin = false
				} else {
					existing.pin = toolId || true
				}
			} else {
				d.docs.push({
					url,
					type: "unknown",
					name: name || "doc",
					pin: toolId || true,
				})
			}
		})
		setSidebarVisible(true)
	}

	// ---- Drag and Drop ----
	function hasPatchworkDrop(dt: DataTransfer | null): boolean {
		return (
			dt?.types?.includes("text/x-patchwork-dnd") ||
			dt?.types?.includes("text/x-patchwork-urls") ||
			false
		)
	}

	function parsePatchworkDrop(
		dt: DataTransfer
	): {url: string; type?: string; name?: string; toolId?: string}[] | null {
		const dndData = dt.getData("text/x-patchwork-dnd")
		if (dndData) {
			try {
				const parsed = JSON.parse(dndData)
				if (parsed.items?.length)
					return parsed.items.map((it: any) => ({
						url: it.url,
						type: it.type,
						name: it.name,
						toolId: it.toolId,
					}))
			} catch {}
		}
		const urlsData = dt.getData("text/x-patchwork-urls")
		if (urlsData) {
			try {
				const urls = JSON.parse(urlsData)
				if (Array.isArray(urls) && urls.length)
					return urls.map((u: string) => ({url: u}))
			} catch {}
		}
		return null
	}

	function handleDragEnter(e: DragEvent) {
		e.preventDefault()
		dragCounter++
		if (hasPatchworkDrop(e.dataTransfer)) {
			// Could show sidebar as drop target
		} else if (e.dataTransfer?.types?.includes("Files")) {
			setShowDropOverlay(true)
		}
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault()
		dragCounter--
		if (dragCounter <= 0) {
			dragCounter = 0
			setShowDropOverlay(false)
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault()
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
	}

	function handleRootDrop(e: DragEvent) {
		e.preventDefault()
		dragCounter = 0
		setShowDropOverlay(false)

		// Handle patchwork doc drops
		if (e.dataTransfer) {
			const patchworkItems = parsePatchworkDrop(e.dataTransfer)
			if (patchworkItems) {
				for (const item of patchworkItems) {
					if (!item.url) continue
					if (pendingEmbeds().some(pe => pe.url === item.url)) continue
					setPendingEmbeds(prev => [...prev, item])
				}
				return
			}
		}

		// Handle file drops
		const files = e.dataTransfer?.files
		if (files && files.length > 0) {
			for (const f of Array.from(files)) {
				const reader = new FileReader()
				reader.onload = () => {
					setPendingFiles(prev => [
						...prev,
						{
							blob: f,
							dataUrl: f.type.startsWith("image/")
								? (reader.result as string)
								: undefined,
							name: f.name,
							mimeType: f.type,
						},
					])
				}
				reader.readAsDataURL(f)
			}
		}
	}

	function handleRootClick(e: MouseEvent) {
		const target = e.target as HTMLElement
		// Open lightbox on image/video clicks within messages
		if (target.tagName === "IMG" && target.closest(".chat-msg-image-wrap")) {
			openLightbox((target as HTMLImageElement).src, "image")
		} else if (
			target.tagName === "VIDEO" &&
			target.closest(".chat-msg-video-wrap")
		) {
			e.preventDefault()
			openLightbox((target as HTMLVideoElement).src, "video")
		}
	}

	// Base capabilities exposed to slot renderers (which may live in another bundle
	// and therefore can't useContext). Assembled from ChatRoot's own scope.
	const slotCaps: SlotBaseCaps = {
		isContext,
		sidebarVisible,
		setSidebarVisible,
		toggleSidebar,
		pinDoc,
		emojiPickerState,
		openEmojiPicker,
		closeEmojiPicker,
		replyToId,
		setReplyToId,
		showEmoticonDialog,
		setShowEmoticonDialog,
		showFontDialog,
		setShowFontDialog,
		openLightbox,
		computerActive,
	}

	return (
		<div
			ref={rootRef}
			class="chat-root"
			classList={{
				"sidebar-left": localStorage.getItem("chat-sidebar-side") === "left",
			}}
			on:click={handleRootClick}
			on:dragenter={handleDragEnter}
			on:dragleave={handleDragLeave}
			on:dragover={handleDragOver}
			on:drop={handleRootDrop}>
			<div class="chat-drop-overlay" classList={{show: showDropOverlay()}}>
				Drop here
			</div>
			<ChatProvider handle={props.handle} element={props.element} selector={props.selector}>
				<IdentityProvider>
					<ThemeProvider rootEl={rootRef}>
						<PresenceProvider handle={props.handle}>
							<SlotProvider caps={slotCaps}>
							<div class="chat-main">
								<Show when={has("presence") || has("sidebar") || has("notifications") || hasSlot("presence-bar-actions")}>
									<PresenceBar
										onToggleSidebar={toggleSidebar}
										computerActive={computerActive()}
									/>
								</Show>
								<MessageList
									replyToId={replyToId()}
									onReply={setReplyToId}
									onReact={openEmojiPicker}
								/>
								<Show when={has("typing")}>
									<TypingBar />
								</Show>
								<Show when={computerAbort()}>
									<div
										class="chat-llm-status"
										style="display:flex;align-items:center;gap:8px;">
										<Show when={llmStatus()}>
											<span>{llmStatus()}</span>
										</Show>
										<button
											class="chat-stop-btn"
											on:pointerdown={(e: PointerEvent) => {
												e.preventDefault()
												e.stopPropagation()
												computerAbort()?.abort()
											}}>
											<svg
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="currentColor">
												<rect x="4" y="4" width="16" height="16" rx="2" />
											</svg>
											Stop
										</button>
									</div>
								</Show>
								<InputArea
									replyToId={replyToId()}
									onClearReply={() => setReplyToId(null)}
									onReply={setReplyToId}
									onShowFontDialog={() => setShowFontDialog(true)}
									onShowEmoticonDialog={() => setShowEmoticonDialog(true)}
									onToggleSidebar={toggleSidebar}
									onComputerCommand={handleComputerCommand}
									onModelCommand={() => void openModelPicker()}
									onPinCommand={handlePinCommand}
									onPluginCommand={handlePluginCommand}
									pendingFiles={pendingFiles()}
									setPendingFiles={setPendingFiles}
									pendingEmbeds={pendingEmbeds()}
									setPendingEmbeds={setPendingEmbeds}
								/>
							</div>
							<Slot name="right-sidebar" />
							<Slot name="emoji-picker-overlay" />
							<Slot name="emoticon-add-dialog" />
							<Slot name="font-add-dialog" />
							<Show when={showPluginPanel()}>
								<div
									class="chat-dialog-overlay"
									on:click={() => setShowPluginPanel(false)}>
									<PluginPanel onClose={() => setShowPluginPanel(false)} />
								</div>
							</Show>
							<Slot name="background" />
							<Lightbox
								src={lightboxSrc()}
								type={lightboxType()}
								onClose={() => setLightboxSrc(null)}
							/>
							</SlotProvider>
						</PresenceProvider>
					</ThemeProvider>
				</IdentityProvider>
			</ChatProvider>
		</div>
	)
}
