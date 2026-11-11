/**
 * The config picker UI. Two exports:
 *   - `dom(opts)`   — the BARE picker element (no frame); embed + own it.
 *   - `popup(opts)` — the picker wrapped in a popover frame (title + Cancel/Done).
 * Both return synchronously (Suspense-style spinner) and reads/write a config
 * source (the account settings doc by default). Framework-free; injects its own
 * namespaced styles (`llmp-`), which inherit the host font + overridable
 * `--llmp-*` colour vars.
 */

import {
	DEFAULTS,
	PARAM_KEYS,
	PROVIDER_CAPS,
	LOCAL_MODELS,
	WEBLLM_MODELS,
	ensureSettingsDoc,
	settingsDocHandle,
	readConfig,
	writeConfig,
	readScopedConfig,
	writeScopeOverride,
	clearScopeOverride,
	hasScopeOverride,
	describeConfig,
	fetchOpenRouterModels,
	fetchOllamaModels,
	fetchGenerationConfig,
	generationConfigFromFiles,
	suggestedParams,
	suggestedParamsFromOpenRouter,
	generationStops,
	capNote,
} from "./config.js"
import {registerLocalModel, generateWithTools} from "./client.js"
import {builtinSupported, builtinAvailability} from "./builtin.js"
import {
	createLLMTool,
	createPromptDoc,
	resolveTools,
	resolvePromptDocs,
	ensureFolderUrl,
	addToFolder,
	removeFromFolder,
} from "./tools.js"
import {PROMPT_TEMPLATES} from "./templates.js"

const DTYPES = ["q4f16", "q4", "q8", "int8", "fp16", "fp32"]
const SECTIONS = [
	{id: "model", label: "Model"},
	{id: "params", label: "Parameters"},
	{id: "prompts", label: "Prompts"},
	{id: "tools", label: "Tool Calling"},
]

const STYLE_ID = "llmp-picker-styles"
// Theme is overridable + plain by default: it inherits the host font, and every
// colour is a `--llmp-*` var a host can set on any ancestor. Neutrals (line, dim,
// soft fills, highlight) are color-mix'd from the text/accent so the picker
// adapts to whatever foreground/accent the surrounding UI uses.
const CSS = `
.llmp {
	/* Follow the active Patchwork theme: accents from --studio-*, fill/line from
	   --editor-*. An explicit --llmp-* override still wins; the pink/cream values
	   are the last-resort fallback (e.g. the "Sundae" theme reproduces them). */
	--accent: var(--llmp-accent, var(--studio-primary, #ff4d97));
	--accent-text: var(--llmp-accent-text, var(--editor-fill, #fff));
	--accent2: var(--llmp-accent2, var(--studio-secondary, #58cfb0));
	--paper: var(--llmp-bg, var(--editor-fill-offset-10, #fdfbf7));
	--card: var(--llmp-card, var(--editor-fill, #fff));
	--ink: var(--llmp-fg, var(--editor-line, #34313a));
	--accent-soft: var(--llmp-accent-soft, color-mix(in srgb, var(--accent) 13%, var(--card)));
	--line: var(--llmp-line, color-mix(in srgb, var(--ink) 12%, transparent));
	--highlight: var(--llmp-highlight, color-mix(in srgb, var(--accent) 8%, var(--card)));
	--dim: var(--llmp-dim, color-mix(in srgb, var(--ink) 45%, transparent));
	--radius: var(--llmp-radius, var(--studio-radius, 14px)); --radius-sm: var(--llmp-radius-sm, var(--studio-radius-sm, 9px));
	--shadow: var(--llmp-shadow, var(--studio-shadow-lg, 0 12px 34px rgba(0,0,0,.18))); --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
	width: min(840px, 96vw); height: min(760px, 90vh); margin: auto;
	overflow: hidden;
	border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius); padding: 0;
	background: var(--paper); color: var(--ink); box-shadow: var(--shadow);
	font-family: inherit; font-size: 14px; line-height: 1.5;
}
.llmp:popover-open { display: flex; flex-direction: column; }
.llmp::backdrop { background: rgba(0,0,0,.26); }
/* bare: dom() — a plain in-flow panel the host sizes + owns; blends with its bg */
.llmp--bare { display: flex; flex-direction: column; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; border: none; border-radius: 0; box-shadow: none; --paper: var(--llmp-bg, transparent); }
/* inner: popup()'s content region between the header + footer */
.llmp-inner { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* scopebody: the per-scope editor region under the scope switcher bar — grows to
   fill so the status bar stays pinned at the bottom of the modal */
.llmp-scopebody { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.llmp-statusbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-top: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); background: var(--card); }
.llmp-statusbar-label { font-size: 9px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--dim); }
.llmp-statusbar-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10px/1.4 ui-monospace, Menlo, monospace; color: var(--ink); }
.llmp-statusbar-copy { flex: none; cursor: var(--studio-cursor-pointer, pointer); padding: 2px 5px; font-size: 12px; color: var(--dim); background: none; border: none; border-radius: 6px; }
.llmp-statusbar-copy:hover { color: var(--ink); background: var(--highlight); }
/* Suspense placeholder while config resolves (dom() returns synchronously). */
.llmp-loading { flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center; }
.llmp-spinner { width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: llmp-spin .7s linear infinite; }
@keyframes llmp-spin { to { transform: rotate(360deg); } }

.llmp-header {
	flex: none; display: flex; align-items: center; justify-content: space-between;
	padding: 14px 18px; font-weight: 700; font-size: 16px; border-bottom: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line);
}
.llmp-close { background: none; border: none; color: var(--dim); font-size: 22px; line-height: 1; cursor: var(--studio-cursor-pointer, pointer); }
.llmp-close:hover { color: var(--ink); }

.llmp-main { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.llmp-side { flex: 0 0 116px; display: flex; flex-direction: column; gap: 4px; padding: 14px 10px; border-right: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); }
.llmp-side button { text-align: left; padding: 8px 11px; font: inherit; font-weight: 600; cursor: var(--studio-cursor-pointer, pointer); color: var(--ink); background: transparent; border: none; border-radius: var(--radius-sm); }
.llmp-side button:hover { background: var(--accent-soft); }
.llmp-side button.active { background: var(--accent); color: var(--accent-text); }
.llmp-content { flex: 1; min-width: 0; overflow: auto; display: flex; flex-direction: column; }

.llmp-tabs { display: flex; gap: 6px; padding: 14px 16px 0; }
.llmp-tabs button { flex: 1; padding: 7px 10px; font: inherit; font-weight: 600; cursor: var(--studio-cursor-pointer, pointer); color: var(--ink); background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); }
.llmp-tabs button:hover { background: var(--highlight); }
.llmp-tabs button.active { background: var(--accent); color: var(--accent-text); border-color: transparent; }

.llmp-recent { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 12px 16px 0; }
.llmp-recent:empty { display: none; }
.llmp-recent-label { font-size: 10px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--dim); margin-right: 2px; }
.llmp-chip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 10px; font: inherit; font-size: 11px; font-weight: 600; cursor: var(--studio-cursor-pointer, pointer); color: var(--ink); background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: 999px; box-shadow: var(--shadow-sm); }
.llmp-chip:hover { background: var(--highlight); }
.llmp-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }

.llmp-params-head { display: flex; justify-content: flex-end; }

.llmp-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.llmp-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dim); }
.llmp-input, .llmp-body select { width: 100%; box-sizing: border-box; padding: 8px 11px; font: inherit; color: var(--ink); background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); }
.llmp-input:focus, .llmp-body select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.llmp-textarea { min-height: 80px; resize: vertical; font-family: ui-monospace, Menlo, monospace; line-height: 1.5; }

/* Select2-style editable combobox */
.llmp-combo { position: relative; width: 100%; }
.llmp-row .llmp-combo { flex: 1; }
.llmp-combo-input { padding-right: 30px; }
.llmp-combo-caret { position: absolute; top: 0; right: 1px; height: 100%; width: 28px; display: flex; align-items: center; justify-content: center; color: var(--dim); font-size: 11px; cursor: var(--studio-cursor-pointer, pointer); user-select: none; transition: transform max(1ms, calc(.12s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))); }
.llmp-combo-caret:hover { color: var(--ink); }
.llmp-combo-input[aria-expanded=true] + .llmp-combo-caret { transform: rotate(180deg); color: var(--accent); }
.llmp-combo-menu { position: fixed; z-index: 10; overflow-y: auto; padding: 5px; background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow); }
.llmp-combo-opt { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-radius: 7px; cursor: var(--studio-cursor-pointer, pointer); }
.llmp-combo-opt.active { background: var(--accent-soft); }
.llmp-combo-opt.current .llmp-combo-opt-label::after { content: " ✓"; color: var(--accent); }
.llmp-combo-opt-label { font-size: 13px; font-weight: 600; color: var(--ink); }
.llmp-combo-opt-sub { font-size: 11px; color: var(--dim); font-family: ui-monospace, Menlo, monospace; }
.llmp-combo-empty { padding: 9px 10px; font-size: 12px; color: var(--dim); }
.llmp-row { display: flex; gap: 8px; }
.llmp-row .llmp-input, .llmp-row select { flex: 1; }

.llmp-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dim); }
.llmp-explain { font-style: italic; color: #aaa3ae; }
.llmp-disabled { opacity: 0.45; }
.llmp-locked { font-style: italic; }
.llmp-label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.llmp-reset-one { padding: 1px 7px; font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dim); }
.llmp-reset-one:hover { color: var(--ink); }

/* saved-prompt manager: an inline-editable list */
.llmp-pp-list { display: flex; flex-direction: column; gap: 6px; }
.llmp-pp-list:empty { display: none; }
.llmp-pp-row { display: flex; align-items: center; gap: 6px; padding: 5px 7px; background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); }
.llmp-pp-row.active { border-color: var(--accent); background: var(--accent-soft); }
.llmp-pp-pick { flex: 0 0 auto; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; font-size: 13px; cursor: var(--studio-cursor-pointer, pointer); color: var(--dim); background: none; border: none; border-radius: 999px; }
.llmp-pp-pick:hover { color: var(--ink); }
.llmp-pp-row.active .llmp-pp-pick { color: var(--accent); }
.llmp-pp-name { flex: 1; min-width: 0; padding: 5px 8px; font-weight: 600; border-color: transparent; background: transparent; box-shadow: none; }
.llmp-pp-name:hover { border-color: var(--line); background: var(--paper); }
.llmp-pp-name:focus { border-color: var(--accent); background: var(--card); }
.llmp-iconbtn { flex: 0 0 auto; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; font-size: 12px; cursor: var(--studio-cursor-pointer, pointer); color: var(--dim); background: none; border: none; border-radius: var(--radius-sm); }
.llmp-iconbtn:hover { background: var(--highlight); color: var(--ink); }
.llmp-warn { margin: 0; font-size: 11px; font-weight: 600; line-height: 1.45; color: var(--accent); }
.llmp-warn:empty { display: none; }

.llmp-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.llmp-pills:empty { display: none; }
.llmp-pill { padding: 3px 9px; font-size: 10px; font-weight: 700; letter-spacing: .2px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.llmp-pill.warn { background: var(--accent); color: var(--accent-text); }
.llmp-pill.muted { background: #f1ece3; color: var(--dim); }

.llmp-temp { display: flex; align-items: center; gap: 10px; }
.llmp-temp input[type=range] { flex: 1; accent-color: var(--accent); }
.llmp-temp b { min-width: 2.6em; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink); }

.llmp-tools { display: flex; flex-direction: column; gap: 10px; }
.llmp-builtins { display: flex; flex-direction: column; gap: 6px; }
.llmp-builtin { padding: 8px 11px; background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); }
.llmp-builtin b { display: block; font: 600 12px/1.4 ui-monospace, Menlo, monospace; color: var(--accent); margin-bottom: 2px; }
.llmp-tool-card { display: flex; flex-direction: column; gap: 8px; padding: 11px; background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); }
.llmp-handler { display: block; height: 260px; overflow: hidden; background: var(--paper); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); }
.llmp-tryout { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 11px/1.5 ui-monospace, Menlo, monospace; color: var(--ink); background: #f7f2ea; border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); padding: 9px; }
.llmp-tryout:empty { display: none; }
.llmp-avail { font-size: 12px; font-weight: 600; color: var(--dim); }

.llmp-custom-rows { display: flex; flex-direction: column; gap: 8px; }
.llmp-custom-rows:empty { display: none; }
.llmp-custom-row { display: flex; flex-direction: column; gap: 6px; padding: 9px 11px; background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); }

.llmp-footer { flex: none; display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); }
.llmp-btn { padding: 8px 15px; font: inherit; font-weight: 600; cursor: var(--studio-cursor-pointer, pointer); color: var(--ink); background: var(--card); border: var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); transition: background max(1ms, calc(.12s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))), box-shadow max(1ms, calc(.12s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))), transform max(1ms, calc(.08s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1))); }
.llmp-btn:hover { background: var(--highlight); box-shadow: 0 2px 7px rgba(52,49,58,.12); }
.llmp-btn:active { transform: translateY(1px); }
.llmp-btn[disabled] { opacity: var(--studio-disabled-opacity, .5); cursor: var(--studio-cursor-default, default); }
.llmp-btn.primary { background: var(--accent); color: var(--accent-text); border-color: transparent; }
.llmp-btn.primary:hover { background: #ff63a6; }
/* scope switcher: text-link buttons; the active one is primary with a primary
   underline drawn as a real bottom border (so it sits on the bar baseline) */
.llmp-scopebtn { padding: 4px 2px; font: inherit; font-weight: 600; cursor: var(--studio-cursor-pointer, pointer); color: var(--dim); background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; }
.llmp-scopebtn:hover { color: var(--accent); }
.llmp-scopebtn.active { color: var(--accent); border-bottom-color: var(--accent); }
`

/**
 * @typedef {{value: string, label?: string}} ComboOption
 * @typedef {Object} ComboOpts
 * @property {string} [value]
 * @property {string} [placeholder]
 * @property {ComboOption[]} [options]
 * @property {(v: string) => void} [onChange]
 * @property {(v: string) => void} [onCommit]
 *
 * @typedef {Object} ComboHandle
 * @property {HTMLInputElement} input
 * @property {HTMLElement} field
 * @property {(next: ComboOption[]) => void} setOptions
 * @property {(v: string|null|undefined) => void} setValue
 *
 * @typedef {Object} PickerSource
 * @property {() => import("./config.js").LLMConfig} read
 * @property {(next: import("./config.js").LLMConfig) => void} write
 * @property {string} [url]
 *
 * @typedef {Object} PickerOpts
 * @property {PickerSource} [source]
 * @property {string[]} [locked]
 * @property {{name?: string, text?: string}} [toolPrompt]
 * @property {any[]} [tools]
 * @property {Array<{name: string, description?: string, defaultOff?: boolean}>} [toolTools]  host-tool-provided built-in tools
 * @property {string} [toolName]  label for the host tool's built-in tools
 * @property {() => void} [onRequestClose]
 * @property {{toolId: string, docId?: string, toolName?: string, docName?: string}} [scope]
 * @property {boolean} [scopePanel]  show the Default·Tool·Doc scope switcher (default true when `scope` is given; set false to hide it and edit the default config)
 *
 * @typedef {{commit: () => any, revert: () => void, cancel: () => void}} Ctl  the live picker controller
 */

function injectStyles() {
	// Upsert: if an older bundle already injected this stylesheet, refresh its
	// contents so CSS changes (new rules, tweaks) actually take effect instead of
	// being shadowed by the stale copy in <head>.
	let s = /** @type {HTMLStyleElement|null} */ (document.getElementById(STYLE_ID))
	if (!s) {
		s = document.createElement("style")
		s.id = STYLE_ID
		document.head.appendChild(s)
	}
	if (s.textContent !== CSS) s.textContent = CSS
}

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {any} [children]
 * @returns {any}
 */
function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag)
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v
		else if (k === "text") node.textContent = v
		else if (k.startsWith("on") && typeof v === "function")
			node.addEventListener(k.slice(2).toLowerCase(), v)
		else if (v != null) node.setAttribute(k, v)
	}
	for (const c of /** @type {any[]} */ ([].concat(children))) {
		if (c == null) continue
		node.append(c.nodeType ? c : document.createTextNode(String(c)))
	}
	return node
}

// An editable combobox, Select2-style: a free-text input you can type any id
// into, plus a floating dropdown of suggestions. Clicking the caret opens the
// full list (text selected, unfiltered "as if blank"); typing filters it.
//
// The menu is `position: fixed`, appended into the `.llmp` popover — so it joins
// the top layer (paints above everything) yet escapes the content area's
// `overflow: auto` clipping. `onChange(v)` fires live as you type; `onCommit(v)`
// fires when a value is committed (pick / Enter / blur).
/**
 * @param {ComboOpts} opts
 * @returns {ComboHandle}
 */
function combo({value, placeholder, options = [], onChange, onCommit}) {
	let opts = options.slice()
	let view = opts // currently shown (filtered) options
	let active = -1 // highlighted index in `view`
	let dirty = false // has the user typed since opening? (false = show all)
	let isOpen = false
	let committed = value || ""

	const input = /** @type {HTMLInputElement} */ (el("input", {
		class: "llmp-input llmp-combo-input",
		placeholder: placeholder || "",
		value: value || "",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		role: "combobox",
		"aria-expanded": "false",
	}))
	const caret = el("span", {class: "llmp-combo-caret", text: "▾"})
	const field = el("div", {class: "llmp-combo"}, [input, caret])
	const menu = el("div", {class: "llmp-combo-menu", role: "listbox"})

	const computeView = () => {
		if (!dirty) return opts
		const q = input.value.trim().toLowerCase()
		if (!q) return opts
		return opts.filter((o) =>
			(o.value + " " + (o.label || "")).toLowerCase().includes(q)
		)
	}
	const position = () => {
		const r = input.getBoundingClientRect()
		menu.style.left = r.left + "px"
		menu.style.top = r.bottom + 5 + "px"
		menu.style.width = r.width + "px"
		menu.style.maxHeight = Math.max(140, Math.min(300, window.innerHeight - r.bottom - 16)) + "px"
	}
	const paintActive = () => {
		;[...menu.children].forEach((c, i) => c.classList.toggle("active", i === active))
		const a = menu.children[active]
		a && a.scrollIntoView({block: "nearest"})
	}
	const renderMenu = () => {
		view = computeView()
		menu.replaceChildren()
		if (!view.length) {
			menu.append(
				el("div", {class: "llmp-combo-empty", text: "No matches — Enter keeps what you typed"})
			)
			return
		}
		view.forEach((o, i) => {
			const item = el("div", {
				class:
					"llmp-combo-opt" +
					(i === active ? " active" : "") +
					(o.value === committed ? " current" : ""),
				role: "option",
			})
			item.append(el("span", {class: "llmp-combo-opt-label", text: o.label || o.value}))
			if (o.label && o.label !== o.value)
				item.append(el("span", {class: "llmp-combo-opt-sub", text: o.value}))
			// mousedown (not click) so it runs before the input's blur closes us.
			item.addEventListener("mousedown", (/** @type {MouseEvent} */ e) => {
				e.preventDefault()
				choose(o.value)
			})
			item.addEventListener("mousemove", () => {
				if (active !== i) {
					active = i
					paintActive()
				}
			})
			menu.append(item)
		})
	}
	const onScroll = () => isOpen && position()
	const open = (/** @type {boolean} */ selectAll) => {
		if (!isOpen) {
			isOpen = true
			dirty = false
			active = -1
			input.setAttribute("aria-expanded", "true")
			;(input.closest(".llmp") || document.body).append(menu)
			position()
			renderMenu()
			window.addEventListener("scroll", onScroll, true)
			window.addEventListener("resize", position)
		}
		if (selectAll) input.select()
	}
	const closeMenu = () => {
		if (!isOpen) return
		isOpen = false
		input.setAttribute("aria-expanded", "false")
		menu.remove()
		window.removeEventListener("scroll", onScroll, true)
		window.removeEventListener("resize", position)
	}
	/** @param {string} [v] */
	const commit = (v) => {
		v = (v == null ? input.value : v).trim()
		if (v === committed) return
		committed = v
		onCommit && onCommit(v)
	}
	const choose = (/** @type {string} */ v) => {
		input.value = v
		dirty = false
		onChange && onChange(v)
		commit(v)
		closeMenu()
	}

	input.addEventListener("focus", () => open(false))
	input.addEventListener("input", () => {
		dirty = true
		onChange && onChange(input.value.trim())
		active = -1
		if (!isOpen) open(false)
		else {
			renderMenu()
			position()
		}
	})
	// Let an option's mousedown land before blur tears the menu down.
	input.addEventListener("blur", () => setTimeout(() => {
		commit()
		closeMenu()
	}, 0))
	input.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
		if (e.key === "ArrowDown") {
			e.preventDefault()
			if (!isOpen) return open(false)
			active = Math.min(view.length - 1, active + 1)
			paintActive()
		} else if (e.key === "ArrowUp") {
			e.preventDefault()
			active = Math.max(0, active - 1)
			paintActive()
		} else if (e.key === "Enter") {
			if (isOpen && active >= 0 && view[active]) {
				e.preventDefault()
				choose(view[active].value)
			} else {
				commit()
				closeMenu()
			}
		} else if (e.key === "Escape" && isOpen) {
			e.preventDefault()
			e.stopPropagation()
			closeMenu()
		}
	})
	caret.addEventListener("mousedown", (/** @type {MouseEvent} */ e) => {
		e.preventDefault()
		if (isOpen) return closeMenu()
		input.focus()
		open(true) // full list + select the text, "as if blank"
	})

	return {
		input,
		field,
		setOptions(/** @type {ComboOption[]} */ next) {
			opts = next.slice()
			if (isOpen) renderMenu()
		},
		setValue(/** @type {string|null|undefined} */ v) {
			input.value = v || ""
			committed = v || ""
		},
	}
}

/**
 * @param {string} text
 * @param {string} [kind]
 */
function pill(text, kind) {
	return el("span", {class: "llmp-pill" + (kind ? " " + kind : ""), text})
}

/** @param {number} [n] */
function fmtParams(n) {
	if (!n) return null
	return n >= 1e9
		? (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B params"
		: Math.round(n / 1e6) + "M params"
}
/** @param {number} n */
function fmtCtx(n) {
	return n >= 1000 ? Math.round(n / 1000) + "K" : String(n)
}

// generation_config.json parsed out of an uploaded folder, keyed by
// "local/<folder>". Session-only, like the registration itself.
/** @type {Map<string, any>} */
const localGenConfig = new Map()

const PARAM_LABELS = {
	temperature: "temp",
	topP: "top-p",
	topK: "top-k",
	minP: "min-p",
	typicalP: "typical-p",
	repetitionPenalty: "rep",
	noRepeatNgramSize: "no-repeat n-gram",
	frequencyPenalty: "freq",
	presencePenalty: "presence",
	maxTokens: "max out",
}

/** @param {{path:string, blob:Blob}[]} files */
async function hasChatTemplate(files) {
	const at = (/** @type {string} */ n) =>
		files.find((f) => f.path.split("/").pop() === n)
	if (at("chat_template.jinja")) return true
	const tc = at("tokenizer_config.json")
	if (!tc) return false
	try {
		return !!JSON.parse(await tc.blob.text()).chat_template
	} catch {
		return false
	}
}

// Ask the HuggingFace API whether a model exists and ships an ONNX export —
// that's the requirement for transformers.js to run it in the browser.
/**
 * @param {string} id
 * @returns {Promise<{exists?: boolean, error?: boolean, hasOnnx?: boolean, canUseTool?: boolean, params?: number, gated?: boolean}>}
 */
async function fetchModelInfo(id) {
	const res = await fetch("https://huggingface.co/api/models/" + id)
	if (res.status === 404) return {exists: false}
	if (!res.ok) return {error: true}
	const data = await res.json()
	const hasOnnx = (data.siblings || []).some((/** @type {any} */ s) =>
		/(^|\/)onnx\/.+\.onnx$|^.+\.onnx$/.test(s.rfilename || "")
	)
	const chatTemplate =
		data.config?.tokenizer_config?.chat_template || data.config?.chat_template_jinja
	const templates =
		typeof chatTemplate === "string"
			? [chatTemplate]
			: chatTemplate && typeof chatTemplate === "object"
				? Object.values(chatTemplate)
				: []
	let canUseTool = false
	for (const template of templates) {
		if (
			typeof template === "string" &&
			/\btools\b/.test(template) &&
			/tool[_ ]?calls?|tool_response|role\s*==\s*["']tool["']/.test(template)
		) {
			canUseTool = true
			break
		}
	}
	return {
		exists: true,
		hasOnnx,
		canUseTool,
		params: data.safetensors?.total,
		gated: !!data.gated,
	}
}

/**
 * Build the bare picker UI (sidebar + content + status bar) into `host` — no
 * outer frame. `dom()` hands you `host` directly; `popup()` wraps it in a
 * popover frame with a header + Cancel/Done. The caller has already resolved
 * config (settings doc or custom source), so reads are synchronous here.
 * Returns `{commit, revert, cancel}` (the wrappers drive close/cancel).
 */
/**
 * @param {HTMLElement} host
 * @param {PickerOpts} opts
 * @returns {Ctl}
 */
function buildPickerInto(host, opts) {
	const source = opts.source || {
		read: () => readConfig(),
		write: (/** @type {any} */ next) => writeConfig(next),
	}

	// Snapshot to revert to if the user cancels (pristine — cfg's nested objects
	// are copies, and arrays are only ever replaced, never mutated in place).
	const before = source.read()
	/** @type {any} */
	const baseCfg = {
		...before, // all scalar params (temperature, topP, topK, penalties, seed, maxTokens, …)
		local: {...before.local},
		openrouter: {...before.openrouter},
		ollama: {...before.ollama},
		webllm: {...before.webllm},
		builtin: {...before.builtin},
		// tools / prompts are folder URLs (strings|null); systemUrl/preUrl select
		// which prompt docs are active. All come in via ...before.
	}

	// Autosave: every change writes through to the account doc (debounced so a
	// slider drag or typing coalesces into one write). `cfg` is a reactive proxy
	// over `baseCfg`; mutating any field — at any depth — schedules a persist.
	/** @type {any} */
	let persistTimer = null
	function flushPersist() {
		if (persistTimer) {
			clearTimeout(persistTimer)
			persistTimer = null
		}
		source.write(baseCfg)
	}
	function schedulePersist() {
		clearTimeout(persistTimer)
		persistTimer = setTimeout(flushPersist, 300)
	}
	const reactive = (/** @type {any} */ target) =>
		new Proxy(target, {
			get(t, k, r) {
				const v = Reflect.get(t, k, r)
				// Wrap nested plain objects so their mutations bubble up; arrays are
				// replaced wholesale (never mutated in place), so leave them raw.
				return v && typeof v === "object" && !Array.isArray(v) ? reactive(v) : v
			},
			set(t, k, v, r) {
				const ok = Reflect.set(t, k, v, r)
				schedulePersist()
				return ok
			},
			deleteProperty(t, k) {
				const ok = Reflect.deleteProperty(t, k)
				schedulePersist()
				return ok
			},
		})
	/** @type {any} */
	const cfg = reactive(baseCfg)

	/** @type {any[]} */
	let orModels = []
	/** @type {string[]} */
	let ollamaModels = []

	const body = el("div", {class: "llmp-body"})
	const tabsBar = el("div", {class: "llmp-tabs"})
	const recentBar = el("div", {class: "llmp-recent"})

	// Persist any pending change + return the live config (Done). Revert restores
	// the open-time snapshot (Cancel). The wrappers (dom/popup) call these.
	function commit() {
		flushPersist()
		return source.read()
	}
	function revert() {
		clearTimeout(persistTimer)
		source.write(before)
	}
	// Drop any pending write WITHOUT touching the source (neither commit nor
	// revert writes). Used when the caller is about to delete this scope's config
	// entirely — a flush/revert would re-create the very override we're removing.
	function cancel() {
		clearTimeout(persistTimer)
		persistTimer = null
	}
	// Open a folder doc in the host app, then ask the wrapper to close the picker.
	function openFolder(/** @type {string|null|undefined} */ url) {
		if (!url) return
		host.dispatchEvent(
			new CustomEvent("patchwork:open-document", {
				detail: {url}, // no toolId — a folder doc opens as a folder by default
				bubbles: true,
				composed: true,
			})
		)
		opts.onRequestClose?.()
	}

	// --- recent-models history -------------------------------------------------
	function modelForProvider(/** @type {string} */ provider) {
		if (provider === "openrouter") return cfg.openrouter.model
		if (provider === "ollama") return cfg.ollama.model
		if (provider === "webllm") return cfg.webllm.model
		if (provider === "builtin") return null // one model, no id
		return cfg.local.model
	}
	const sameRecent = (/** @type {any} */ a, /** @type {any} */ b) =>
		a.provider === b.provider && (a.model || null) === (b.model || null)
	function recordRecent() {
		const entry = {provider: cfg.provider, model: modelForProvider(cfg.provider) || null}
		if (entry.provider !== "builtin" && !entry.model) return
		const prev = Array.isArray(cfg.recentModels) ? cfg.recentModels : []
		cfg.recentModels = [entry, ...prev.filter((/** @type {any} */ r) => !sameRecent(r, entry))].slice(0, 12)
	}
	function applyRecent(/** @type {any} */ r) {
		cfg.provider = r.provider
		if (r.provider === "openrouter") cfg.openrouter.model = r.model
		else if (r.provider === "ollama") cfg.ollama.model = r.model
		else if (r.provider === "webllm") cfg.webllm.model = r.model
		else if (r.provider === "local") cfg.local.model = r.model
		recordRecent() // re-selecting bumps it to the front
		renderRecent()
		renderTabs()
		renderBody()
	}
	function renderRecent() {
		recentBar.replaceChildren()
		const recents = Array.isArray(cfg.recentModels) ? cfg.recentModels : []
		if (!recents.length) return
		recentBar.append(el("span", {class: "llmp-recent-label", text: "Recent"}))
		const current = {
			provider: cfg.provider,
			model: modelForProvider(cfg.provider) || null,
		}
		for (const r of recents.slice(0, 8)) {
			recentBar.append(
				el("button", {
					class: "llmp-chip" + (sameRecent(r, current) ? " active" : ""),
					title: r.provider + (r.model ? " · " + r.model : ""),
					text: r.provider === "builtin" ? "Chrome built-in" : r.model || "—",
					onClick: () => applyRecent(r),
				})
			)
		}
	}

	function resetParams() {
		for (const k of PARAM_KEYS) cfg[k] = /** @type {Record<string, any>} */ (DEFAULTS)[k]
		renderSection() // re-render the Parameters section with the defaults
	}

	/**
	 * The "the people who made this model suggest…" row, shared by the Browser and
	 * OpenRouter model pickers. `params` is already in picker-config keys; a param
	 * the current provider can't do is shown struck through and not applied.
	 * @param {Record<string, number>} params
	 * @param {string} source  where the numbers came from, for the pill
	 * @returns {(HTMLElement|null)[]}
	 */
	function suggestedRow(params, source) {
		const usable = Object.fromEntries(
			Object.entries(params).filter(([k]) => !capNote(cfg.provider, k))
		)
		const keys = Object.keys(params)
		if (!keys.length) return []
		const label = keys
			.map((k) => {
				const name = /** @type {any} */ (PARAM_LABELS)[k] || k
				return k in usable ? `${name} ${params[k]}` : `${name} n/a`
			})
			.join(" · ")
		const apply = el("button", {
			class: "llmp-btn",
			text: "Use these",
			disabled: Object.keys(usable).length ? null : "",
			onClick: () => {
				// The Parameters section is a different section and rebuilds when
				// navigated to, so don't renderSection() here — it would tear down
				// this very row.
				Object.assign(cfg, usable)
				apply.textContent = "✓ applied"
				apply.disabled = true
			},
		})
		return [
			pill(`suggested by ${source || "the model"}: ${label}`, "muted"),
			apply,
		]
	}

	const isBrowser = () =>
		cfg.provider === "local" ||
		cfg.provider === "webllm" ||
		cfg.provider === "builtin"
	function renderTabs() {
		const tabs = [
			["local", "Browser"],
			["openrouter", "OpenRouter"],
			["ollama", "Ollama"],
		]
		tabsBar.replaceChildren(
			...tabs.map(([id, label]) =>
				el("button", {
					class: (id === "local" ? isBrowser() : cfg.provider === id) ? "active" : "",
					text: label,
					onClick: () => {
						if (id === "local") {
							if (!isBrowser()) cfg.provider = "local"
						} else cfg.provider = id
						renderTabs()
						renderBody()
					},
				})
			)
		)
	}

	function renderBody() {
		body.replaceChildren()
		if (cfg.provider === "openrouter") renderOpenRouter()
		else if (cfg.provider === "ollama") renderOllama()
		else renderLocal() // local (transformers) / webllm / builtin
		renderRecent() // keep the active chip in sync with the current provider
	}

	// A "↺ default" affordance beside a param that's been moved off DEFAULTS —
	// so applying a model's suggestions (or fiddling) is always one click from
	// undone, per param, without resetting the whole section.
	/** @param {string|undefined} key */
	function resetOne(key) {
		if (!key) return null
		const def = /** @type {Record<string, any>} */ (DEFAULTS)[key]
		if ((cfg[key] ?? null) === (def ?? null)) return null
		return el("button", {
			class: "llmp-btn llmp-reset-one",
			text: `↺ ${def == null ? "auto" : def}`,
			title: `Reset to the default (${def == null ? "auto" : def})`,
			onClick: (/** @type {any} */ e) => {
				e.preventDefault()
				cfg[key] = def
				renderSection()
			},
		})
	}

	/**
	 * @param {string} label
	 * @param {number} value
	 * @param {{min?: any, max?: any, step?: any, onInput: (v: number) => void, note?: string, disabled?: string|null, key?: string}} cfg2
	 */
	function slider(label, value, {min, max, step, onInput, note, disabled, key}) {
		const out = el("b", {text: (+value).toFixed(2)})
		const range = el("input", {
			type: "range",
			min,
			max,
			step,
			value: String(value),
			onInput: (/** @type {any} */ e) => {
				const v = +e.currentTarget.value
				out.textContent = v.toFixed(2)
				onInput(v)
			},
		})
		if (disabled) range.disabled = true
		const wrapper = el("label", {class: "llmp-label" + (disabled ? " llmp-disabled" : "")}, [
			el("span", {class: "llmp-label-row"}, [label, disabled ? null : resetOne(key)]),
			el("div", {class: "llmp-temp"}, [range, out]),
			note ? el("p", {class: "llmp-note", text: note}) : null,
		])
		if (disabled) wrapper.append(el("p", {class: "llmp-note llmp-locked", text: disabled}))
		return wrapper
	}

	/**
	 * @param {string} label
	 * @param {number|null} value
	 * @param {{min?: any, step?: any, placeholder?: string, onInput: (v: number|null) => void, note?: string, disabled?: string|null, key?: string}} [cfg2]
	 */
	function numberField(label, value, cfg2 = /** @type {any} */ ({})) {
		const {min, step, placeholder, onInput, note, disabled, key} = cfg2
		const input = el("input", {
			class: "llmp-input",
			type: "number",
			min,
			step,
			placeholder,
			onInput: (/** @type {any} */ e) => {
				const raw = e.currentTarget.value
				onInput(raw === "" ? null : +raw)
			},
		})
		if (value != null) input.value = String(value)
		if (disabled) input.disabled = true
		const wrapper = el("label", {class: "llmp-label" + (disabled ? " llmp-disabled" : "")}, [
			el("span", {class: "llmp-label-row"}, [label, disabled ? null : resetOne(key)]),
			input,
			note ? el("p", {class: "llmp-note", text: note}) : null,
		])
		if (disabled) wrapper.append(el("p", {class: "llmp-note llmp-locked", text: disabled}))
		return wrapper
	}

	// Dedicated "Parameters" section — every sampling/decoding knob.
	function renderParamsSection() {
		const wrap = el("div", {class: "llmp-body"})
		content.append(wrap)

		const locked = opts.locked || []
		// Greying a control out without saying why is a small cruelty. Two reasons
		// exist: the host tool passes this per call (so your value is overwritten),
		// or the provider's runtime has nowhere to put it (see CAP_NOTES).
		function paramState(/** @type {string} */ key) {
			if (locked.includes(key))
				return `Set by the tool you're in — it passes this with every request, so a value here wouldn't reach the model.`
			return capNote(cfg.provider, key)
		}

		const atDefaults = PARAM_KEYS.every((k) => (cfg[k] ?? null) === (/** @type {Record<string, any>} */ (DEFAULTS)[k] ?? null))
		wrap.append(
			el("div", {class: "llmp-params-head"}, [
				el("button", {
					class: "llmp-btn llmp-reset",
					text: "Reset to defaults",
					disabled: atDefaults ? "" : null,
					onClick: resetParams,
				}),
			])
		)
		wrap.append(
			slider("Temperature", cfg.temperature, {
				min: "0",
				max: "2",
				step: "0.05",
				onInput: (v) => (cfg.temperature = v),
				note: "Randomness of each pick. 0 = always the top token (deterministic); ~0.7 balanced; past ~1.5 it tips into incoherence.",
				disabled: paramState("temperature"),
				key: "temperature",
			}),
			slider("Top-p (nucleus)", cfg.topP, {
				min: "0",
				max: "1",
				step: "0.01",
				onInput: (v) => (cfg.topP = v),
				note: "Sample from the smallest set of tokens whose probabilities sum to p. 1 = off.",
				disabled: paramState("topP"),
				key: "topP",
			}),
			numberField("Top-k", cfg.topK, {
				min: "0",
				step: "1",
				onInput: (v) => (cfg.topK = v || 0),
				note: "Sample only from the k most likely tokens. 0 = off.",
				disabled: paramState("topK"),
				key: "topK",
			}),
			slider("Min-p", cfg.minP, {
				min: "0",
				max: "1",
				step: "0.01",
				onInput: (v) => (cfg.minP = v),
				note: "Drop tokens below this fraction of the top token's probability. 0 = off.",
				disabled: paramState("minP"),
				key: "minP",
			}),
			slider("Typical-p", cfg.typicalP, {
				min: "0",
				max: "1",
				step: "0.01",
				onInput: (v) => (cfg.typicalP = v),
				note: "Sample from tokens whose surprise is closest to the distribution's average, rather than the most likely ones. 1 = off. (Ollama)",
				disabled: paramState("typicalP"),
				key: "typicalP",
			}),
			slider("Repetition penalty", cfg.repetitionPenalty, {
				min: "1",
				max: "2",
				step: "0.01",
				onInput: (v) => (cfg.repetitionPenalty = v),
				note: "Penalise tokens already used. 1 = off. (transformers · Ollama · OpenRouter)",
				disabled: paramState("repetitionPenalty"),
				key: "repetitionPenalty",
			}),
			numberField("No-repeat n-gram size", cfg.noRepeatNgramSize, {
				min: "0",
				step: "1",
				onInput: (v) => (cfg.noRepeatNgramSize = v || 0),
				note: "Hard-ban any sequence of this many tokens that has already appeared. 3 stops verbatim loops; too low mangles ordinary phrasing. 0 = off. (transformers)",
				disabled: paramState("noRepeatNgramSize"),
				key: "noRepeatNgramSize",
			}),
			slider("Frequency penalty", cfg.frequencyPenalty, {
				min: "-2",
				max: "2",
				step: "0.05",
				onInput: (v) => (cfg.frequencyPenalty = v),
				note: "Penalise tokens by how often they've appeared. 0 = off. (OpenRouter · Ollama · WebLLM)",
				disabled: paramState("frequencyPenalty"),
				key: "frequencyPenalty",
			}),
			slider("Presence penalty", cfg.presencePenalty, {
				min: "-2",
				max: "2",
				step: "0.05",
				onInput: (v) => (cfg.presencePenalty = v),
				note: "Penalise tokens that have appeared at all. 0 = off.",
				disabled: paramState("presencePenalty"),
				key: "presencePenalty",
			}),
			numberField("Max output tokens", cfg.maxTokens, {
				min: "1",
				placeholder: "model default",
				onInput: (v) => (cfg.maxTokens = v),
				disabled: paramState("maxTokens"),
				key: "maxTokens",
			}),
			numberField("Seed", cfg.seed, {
				min: "0",
				step: "1",
				placeholder: "random",
				onInput: (v) => (cfg.seed = v),
				note: "Fix the seed for reproducible output where supported. Blank = random.",
				disabled: paramState("seed"),
				key: "seed",
			})
		)
	}

	function renderLocal() {
		// Engine: transformers.js (ONNX) · WebLLM (MLC) · Chrome built-in.
		const engines = [
			["local", "transformers.js (ONNX)"],
			["webllm", "WebLLM (MLC · WebGPU)"],
		]
		if (builtinSupported()) engines.push(["builtin", "Built-in (Chrome) ✨"])
		const engine = el("select", {
			onChange: (/** @type {any} */ e) => {
				cfg.provider = e.currentTarget.value
				// Built-in has no model combo to commit, so the engine pick *is* the
				// model selection — record it directly.
				if (cfg.provider === "builtin") recordRecent()
				renderBody()
			},
		})
		for (const [val, label] of engines) {
			const o = el("option", {value: val, text: label})
			if (val === cfg.provider) o.selected = true
			engine.append(o)
		}
		body.append(el("label", {class: "llmp-label"}, ["Engine", engine]))

		if (cfg.provider === "webllm") {
			if (!Array.isArray(cfg.webllm.custom)) cfg.webllm.custom = []
			const validCustom = () =>
				cfg.webllm.custom.filter((/** @type {any} */ c) => (c.model_id || "").trim())
			const webllmOptions = () => [
				...WEBLLM_MODELS.map((m) => ({value: m.id, label: m.name})),
				...validCustom().map((/** @type {any} */ c) => ({value: c.model_id, label: "📦 " + c.model_id})),
			]
			const wc = combo({
				value: cfg.webllm.model,
				placeholder: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC or any MLC model_id",
				options: webllmOptions(),
				onChange: (v) => (cfg.webllm.model = v),
				onCommit: () => recordRecent(),
			})

			// Self-compiled MLC models as live-editable rows: model_id + model_lib
			// (the weights URL is derived from the id). Edits write straight through
			// (autosaved); rows stay editable. There's no delete button — clear a
			// row's fields and leave it to drop it.
			const rows = el("div", {class: "llmp-custom-rows"})
			function commitRows() {
				cfg.webllm.custom = [...rows.children]
					.map((/** @type {any} */ r) => ({
						model_id: r._id.value.trim(),
						model_lib: r._lib.value.trim(),
					}))
					.filter((c) => c.model_id || c.model_lib)
				wc.setOptions(webllmOptions())
			}
			/**
			 * @param {any} model
			 * @param {boolean} [focus]
			 */
			function addRow(model, focus) {
				const idIn = el("input", {
					class: "llmp-input",
					placeholder: "model_id  —  e.g. owner/Model-q4f16_1-MLC",
					value: model?.model_id || "",
				})
				const libIn = el("input", {
					class: "llmp-input",
					placeholder: "model_lib URL  —  compiled .wasm",
					value: model?.model_lib || "",
				})
				const row = el("div", {class: "llmp-custom-row"}, [idIn, libIn])
				row._id = idIn
				row._lib = libIn
				idIn.addEventListener("input", commitRows)
				libIn.addEventListener("input", commitRows)
				// Drop a fully-cleared row once you leave it.
				const maybeDrop = () => {
					if (!idIn.value.trim() && !libIn.value.trim()) {
						row.remove()
						commitRows()
					}
				}
				idIn.addEventListener("blur", maybeDrop)
				libIn.addEventListener("blur", maybeDrop)
				rows.append(row)
				if (focus) idIn.focus()
			}
			for (const c of cfg.webllm.custom) addRow(c, false)

			const addBtn = el("button", {
				class: "llmp-btn",
				text: "+ Add model",
				onClick: () => addRow(null, true),
			})

			body.append(
				el("label", {class: "llmp-label"}, ["Model", wc.field]),
				el("p", {
					class: "llmp-note",
					text: "Runs in your browser on WebGPU via MLC WebLLM — a different, non-ONNX engine, often faster. Downloads on first use and exposes next-token probabilities, so the prediction popup works.",
				}),
				el("label", {class: "llmp-label"}, [
					"Custom models",
					el("p", {
						class: "llmp-note llmp-explain",
						text: "Self-compiled MLC models. Give the model_id (its HuggingFace repo, e.g. owner/Model-q4f16_1-MLC) and the compiled wasm lib URL — the weights URL is derived from the id. Stored in your synced config. Clear a row to remove it.",
					}),
					rows,
					el("div", {class: "llmp-row"}, [addBtn]),
				])
			)
			return
		}
		if (cfg.provider === "builtin") {
			const avail = el("p", {class: "llmp-avail", text: "checking availability…"})
			body.append(
				el("p", {
					class: "llmp-note",
					text: "Chrome's on-device model (Gemini Nano). Nothing to download or manage — but it exposes no next-token probabilities, so the prediction popup is off for built-in.",
				}),
				avail
			)
			builtinAvailability().then((s) => {
				avail.textContent =
					s === "available"
						? "✓ Ready on this device"
						: s === "downloadable"
							? "⤓ Will download on first use"
							: s === "downloading"
								? "⤓ Downloading…"
								: "⚠ Not available in this browser"
			})
			return
		}
		function localOptions() {
			const opts = LOCAL_MODELS.map((m) => ({
				value: m.id,
				label: m.name + (m.canUseTool ? " (tool calls)" : ""),
			}))
			if (cfg.local.model?.startsWith("local/"))
				opts.push({value: cfg.local.model, label: "📁 uploaded"})
			return opts
		}
		const pills = el("div", {class: "llmp-pills"})
		const warn = el("p", {class: "llmp-warn"})
		const suggested = el("div", {class: "llmp-pills"})
		const c = combo({
			value: cfg.local.model,
			placeholder: "onnx-community/… or any ONNX HuggingFace id",
			options: localOptions(),
			onChange: (v) => {
				cfg.local.model = v
				refreshPills() // light: catalogue pills only, no network
				refreshSuggested()
			},
			// On a *committed* id (pick / Enter / blur): record it and validate it
			// against the HF API — never per-keystroke (that spammed HF with partial
			// ids → 401/503/CORS).
			onCommit: () => {
				recordRecent()
				scheduleValidate()
			},
		})

		/** @type {any} */
		let validateTimer = null
		// Catalogue/uploaded pills only — no network.
		function refreshPills() {
			clearTimeout(validateTimer)
			pills.replaceChildren()
			warn.textContent = ""
			const id = cfg.local.model
			if (!id) return
			if (id.startsWith("local/")) return void pills.append(pill("📁 uploaded", "muted"))
			const cat = LOCAL_MODELS.find((m) => m.id === id)
			if (cat?.canUseTool) pills.append(pill("supports tool calling"))
		}
		// The model authors' own sampling settings, from the repo's
		// `generation_config.json` (or the uploaded folder's copy). Prefills the
		// Parameters section instead of leaving everyone on our generic 0.7/0.9,
		// which is far too hot for most small local models.
		/** @type {any} */
		let suggestTimer = null
		function refreshSuggested() {
			clearTimeout(suggestTimer)
			suggested.replaceChildren()
			const id = cfg.local.model
			if (!id || cfg.provider !== "local") return
			if (id.startsWith("local/")) return showSuggested(localGenConfig.get(id))
			if (!/^[^/\s]+\/[^/\s]{2,}$/.test(id)) return // must look like org/repo
			suggestTimer = setTimeout(() => {
				suggested.replaceChildren(pill("⟳ reading generation_config.json…", "muted"))
				fetchGenerationConfig(id).then((gc) => {
					if (id === cfg.local.model) showSuggested(gc)
				})
			}, 500)
		}
		/** @param {any} gc parsed generation_config.json, or null/undefined */
		function showSuggested(gc) {
			const params = suggestedParams(gc)
			const {hasEos, greedy} = generationStops(gc)
			suggested.replaceChildren(...suggestedRow(params, "generation_config.json"))
			if (gc && !hasEos)
				suggested.append(
					pill("⚠ no eos_token_id — generation only stops at the token cap", "warn")
				)
			if (greedy) suggested.append(pill("authors want greedy decoding", "muted"))
		}

		function scheduleValidate() {
			clearTimeout(validateTimer)
			const id = cfg.local.model
			if (!id || id.startsWith("local/")) return
			if (LOCAL_MODELS.some((m) => m.id === id)) return // catalogue = known good
			if (!/^[^/\s]+\/[^/\s]{2,}$/.test(id)) return // must look like org/repo
			validateTimer = setTimeout(() => validate(id), 500)
		}
		async function validate(/** @type {string} */ id) {
			refreshPills()
			pills.append(pill("checking HuggingFace…", "muted"))
			let info
			try {
				info = await fetchModelInfo(id)
			} catch {
				refreshPills() // CORS / rate-limited / offline — fail quietly
				return
			}
			if (id !== cfg.local.model) return // changed while we waited
			refreshPills()
			if (info.error) return
			if (!info.exists) {
				warn.textContent = "⚠ Not found on HuggingFace — check the id."
				return
			}
			if (info.params) pills.append(pill(/** @type {string} */ (fmtParams(info.params)), "muted"))
			if (info.canUseTool) pills.append(pill("supports tool calling"))
			if (info.hasOnnx) pills.append(pill("✓ ONNX"))
			else {
				pills.append(pill("no ONNX", "warn"))
				warn.textContent =
					"⚠ This repo has no ONNX export, so it can't run in the browser. Use an onnx-community/… model, or load an ONNX folder from disk below."
			}
			if (info.gated)
				warn.textContent =
					"⚠ This model is gated on HuggingFace — it likely won't download in the browser."
		}

		// ---- load a local ONNX model from disk ----
		const dtypeSel = el("select", {style: "flex:0 0 auto;width:auto"})
		for (const d of DTYPES) {
			dtypeSel.append(el("option", {value: d, text: d}))
		}
		const fileInput = el("input", {
			type: "file",
			webkitdirectory: "",
			directory: "",
			multiple: "",
			style: "display:none",
		})
		const note = el("p", {
			class: "llmp-note",
			text: "Runs via WebGPU in your browser. Or load your own ONNX model folder (transformers.js layout: config.json, tokenizer.json, onnx/model_<dtype>.onnx).",
		})
		fileInput.addEventListener("change", () => {
			const picked = [...(fileInput.files || [])]
			if (!picked.length) return
			const folder = (picked[0].webkitRelativePath || picked[0].name).split("/")[0]
			const files = picked.map((f) => ({
				path: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name,
				blob: f,
			}))
			const id = "local/" + folder
			registerLocalModel(id, files, dtypeSel.value)
			cfg.provider = "local"
			cfg.local.model = id
			c.setValue(id)
			c.setOptions(localOptions())
			refreshPills()
			note.textContent = `Loaded ${files.length} files as ${id} (dtype ${dtypeSel.value}). It will load on first use.`
			generationConfigFromFiles(files).then((gc) => {
				localGenConfig.set(id, gc)
				if (cfg.local.model === id) showSuggested(gc)
			})
			// A model with no chat template can only be prompted as ChatML, which is
			// wrong for anything that isn't Qwen-family — say so at upload time
			// rather than letting it surface as garbage output.
			hasChatTemplate(files).then((ok) => {
				if (!ok && cfg.local.model === id)
					warn.textContent =
						"⚠ No chat template in this folder (tokenizer_config.json / chat_template.jinja) — chat prompts fall back to ChatML, which produces garbage on non-Qwen models."
			})
		})
		const loadBtn = el("button", {
			class: "llmp-btn",
			text: "Load ONNX folder…",
			onClick: () => fileInput.click(),
		})

		// Quantization picker for the chosen model id. transformers.js loads
		// onnx/model_<dtype>.onnx, so a repo that only ships, say, q4 needs this
		// set explicitly — otherwise the default q4f16 file 404s. "auto" = let the
		// worker fall back to the catalogue default / q4f16.
		const modelDtypeSel = el("select", {style: "width:auto"})
		for (const d of ["auto", ...DTYPES]) modelDtypeSel.append(el("option", {value: d, text: d}))
		modelDtypeSel.value = cfg.local.dtype || "auto"
		modelDtypeSel.addEventListener("change", () => {
			cfg.local.dtype = modelDtypeSel.value === "auto" ? null : modelDtypeSel.value
		})

		refreshPills()
		scheduleValidate() // validate a pre-set custom id once on open
		refreshSuggested()
		body.append(
			el("label", {class: "llmp-label"}, ["Model", c.field]),
			pills,
			warn,
			suggested,
			el("label", {class: "llmp-label"}, [
				"Quantization",
				el("div", {class: "llmp-row"}, [modelDtypeSel]),
			]),
			el("p", {class: "llmp-note", text: "Which ONNX variant to load (onnx/model_<dtype>.onnx). Auto = the model's default. Set this if a repo only ships a specific one (e.g. q4)."}),
			el("label", {class: "llmp-label"}, [
				"Load local ONNX from disk",
				el("div", {class: "llmp-row"}, [loadBtn, dtypeSel]),
			]),
			fileInput,
			note
		)
	}

	function renderOpenRouter() {
		const keyInput = el("input", {
			type: "password",
			class: "llmp-input",
			placeholder: "sk-or-...",
			value: cfg.openrouter.apiKey || "",
			onInput: (/** @type {any} */ e) => (cfg.openrouter.apiKey = e.currentTarget.value),
		})
		const orOptions = () => orModels.map((m) => ({value: m.id, label: m.name}))
		const pills = el("div", {class: "llmp-pills"})
		// OpenRouter's answer to generation_config.json: `default_parameters` on
		// each catalogue entry, already in hand from the models fetch.
		const suggested = el("div", {class: "llmp-pills"})
		function refreshSuggested() {
			const m = orModels.find((x) => x.id === cfg.openrouter.model)
			suggested.replaceChildren(
				...suggestedRow(suggestedParamsFromOpenRouter(m?.default_parameters), "OpenRouter")
			)
		}
		function refreshPills() {
			pills.replaceChildren()
			refreshSuggested()
			const m = orModels.find((x) => x.id === cfg.openrouter.model)
			if (!m) return
			const sp = m.supported_parameters || []
			const mods = m.input_modalities || []
			if (m.context_length) pills.append(pill(fmtCtx(m.context_length) + " context", "muted"))
			if (mods.includes("image")) pills.append(pill("👁 vision"))
			if (mods.includes("audio")) pills.append(pill("🔊 audio"))
			if (sp.includes("tools")) pills.append(pill("🔧 tool calling"))
			if (sp.includes("reasoning") || sp.includes("include_reasoning"))
				pills.append(pill("🧠 reasoning"))
			if (sp.includes("logprobs")) pills.append(pill("logprobs"))
			if (m.max_completion_tokens)
				pills.append(pill(fmtCtx(m.max_completion_tokens) + " max out", "muted"))
		}
		const c = combo({
			value: cfg.openrouter.model,
			placeholder: "anthropic/claude-sonnet-4 or any OpenRouter id",
			options: orOptions(),
			onChange: (v) => {
				cfg.openrouter.model = v
				const f = orModels.find((m) => m.id === v)
				cfg.openrouter.contextLength = f?.context_length ?? null
				cfg.openrouter.maxCompletionTokens = f?.max_completion_tokens ?? null
				refreshPills()
			},
			onCommit: () => recordRecent(),
		})
		const refresh = el("button", {class: "llmp-btn", text: "Refresh", onClick: load})
		async function load() {
			refresh.textContent = "..."
			refresh.disabled = true
			try {
				orModels = await fetchOpenRouterModels()
			} catch (e) {
				console.warn("[@patchwork/llm] fetch OpenRouter models:", e)
			}
			refresh.textContent = "Refresh"
			refresh.disabled = false
			c.setOptions(orOptions())
			refreshPills()
		}
		if (!orModels.length) load()
		else refreshPills()
		body.append(
			el("label", {class: "llmp-label"}, [
				"API Key (stored on your account)",
				keyInput,
			]),
			el("label", {class: "llmp-label"}, [
				"Model",
				el("div", {class: "llmp-row"}, [c.field, refresh]),
			]),
			pills,
			suggested
		)
	}

	function renderOllama() {
		const urlInput = el("input", {
			class: "llmp-input",
			placeholder: DEFAULTS.ollama.url,
			value: cfg.ollama.url || "",
			onInput: (/** @type {any} */ e) => (cfg.ollama.url = e.currentTarget.value),
		})
		const select = el("select", {
			onChange: (/** @type {any} */ e) => {
				cfg.ollama.model = e.currentTarget.value
				recordRecent()
			},
		})
		const refresh = el("button", {class: "llmp-btn", text: "Refresh", onClick: load})
		function paint() {
			select.replaceChildren()
			if (!ollamaModels.length)
				select.append(el("option", {value: cfg.ollama.model, text: cfg.ollama.model}))
			for (const m of ollamaModels) {
				const o = el("option", {value: m, text: m})
				if (m === cfg.ollama.model) o.selected = true
				select.append(o)
			}
			select.value = cfg.ollama.model
		}
		async function load() {
			refresh.textContent = "..."
			refresh.disabled = true
			try {
				ollamaModels = await fetchOllamaModels(cfg.ollama.url)
			} catch (e) {
				console.warn("[@patchwork/llm] probe Ollama:", e)
				ollamaModels = []
			}
			refresh.textContent = "Refresh"
			refresh.disabled = false
			paint()
		}
		paint()
		if (!ollamaModels.length) load()
		body.append(
			el("label", {class: "llmp-label"}, [
				"Ollama URL",
				el("div", {class: "llmp-row"}, [urlInput, refresh]),
			]),
			el("label", {class: "llmp-label"}, ["Model", select])
		)
	}

	// ---- Prompts section ----
	function renderPromptsSection() {
		const wrap = el("div", {class: "llmp-body"})
		content.append(wrap)
		renderPromptPicker(wrap, "system")
		renderPromptPicker(wrap, "pre")
	}

	// A saved-prompt manager (used for both system + pre): a list of named prompts
	// you can rename in place, copy, remove, or make active (●); `+ New` creates
	// one, and you can import by URL. The active prompt's text editor shows below.
	/**
	 * @param {any} wrap
	 * @param {"system"|"pre"} kind
	 */
	function renderPromptPicker(wrap, kind) {
		const repo = typeof window !== "undefined" ? window.repo : null
		const isPre = kind === "pre"
		const promptType = isPre ? "llm:pre-prompt" : "llm:system-prompt"
		const urlKey = isPre ? "preUrl" : "systemUrl"
		const header = isPre ? "Pre-prompt" : "System prompt"
		const note = isPre
			? "“Start with this text.” Literal text glued to the front of your input on every call — used everywhere, including completions and predictions."
			: "“Be like this.” Standing instructions sent as a chat system message. ⚠ Not used during raw completions (continuation / keystroke predictions): a completion has no system role."

		const sel = () => cfg[urlKey]
		const setSel = (/** @type {string|null|undefined} */ u) => (cfg[urlKey] = u || null)
		const newName = isPre ? "Pre-prompt" : "System prompt"
		/** @type {any[]} */
		let resolved = []
		/** @type {(() => void)|null} */
		let paintToolCard = null // refreshes the tool-default card's active state

		// Add a prompt doc URL to the prompts folder (creating the folder if needed).
		/**
		 * @param {string} url
		 * @param {string} [name]
		 */
		async function addLink(url, name) {
			if (!repo || !url) return
			cfg.prompts = await ensureFolderUrl(repo, cfg.prompts, "LLM Prompts")
			await addToFolder(repo, cfg.prompts, {name: name || "Prompt", type: promptType, url})
		}
		// Rename: the name lives on the wrapper doc. (Folder DocLinks resolve their
		// name from the doc, so renaming the doc is enough.)
		/**
		 * @param {string} url
		 * @param {string} [name]
		 */
		async function rename(url, name) {
			if (!repo || !url) return
			const h = await repo.find(/** @type {any} */ (url))
			h.change((/** @type {any} */ d) => (d.name = name || "Prompt"))
		}

		const list = el("div", {class: "llmp-pp-list"})
		const empty = el("p", {class: "llmp-note llmp-explain", text: "No saved prompts yet — “+ New” to make one."})
		const editorBox = el("div", {class: "llmp-tools"})

		function paint() {
			list.replaceChildren()
			for (const p of resolved) {
				const active = p.url === sel()
				const nameIn = el("input", {
					class: "llmp-input llmp-pp-name",
					value: p.name || "",
					spellcheck: "false",
				})
				/** @type {any} */
				let renameTimer = null
				nameIn.addEventListener("input", () => {
					clearTimeout(renameTimer)
					const v = nameIn.value
					renameTimer = setTimeout(() => rename(p.url, v.trim()), 350)
				})
				const pick = el("button", {
					class: "llmp-pp-pick",
					title: active ? "Active prompt" : "Make active",
					text: active ? "●" : "○",
					onClick: () => {
						setSel(active ? null : p.url) // click the active one to deactivate
						paint()
					},
				})
				const copyBtn = el("button", {
					class: "llmp-iconbtn",
					title: "Copy URL",
					text: "⧉",
					onClick: () => navigator.clipboard?.writeText(p.url),
				})
				const rm = el("button", {
					class: "llmp-iconbtn",
					title: "Remove",
					text: "✕",
					onClick: async () => {
						if (repo && cfg.prompts) await removeFromFolder(repo, cfg.prompts, p.url)
						if (active) setSel(null)
						reload()
					},
				})
				list.append(
					el("div", {class: "llmp-pp-row" + (active ? " active" : "")}, [
						pick,
						nameIn,
						copyBtn,
						rm,
					])
				)
			}
			empty.style.display = resolved.length ? "none" : ""
			// Editor for the active prompt.
			editorBox.replaceChildren()
			const cur = resolved.find((p) => p.url === sel())
			if (cur?.promptUrl) {
				const view = document.createElement("patchwork-view")
				view.setAttribute("doc-url", cur.promptUrl) // the .txt file doc
				view.setAttribute("tool-id", "file")
				view.className = "llmp-handler"
				editorBox.append(view)
			}
			if (paintToolCard) paintToolCard()
		}
		async function reload() {
			resolved = repo ? await resolvePromptDocs(cfg, kind, repo) : []
			paint()
		}

		const newBtn = el("button", {
			class: "llmp-btn primary",
			text: "+ New",
			onClick: async () => {
				if (!repo) return
				const w = await createPromptDoc(repo, kind, {name: newName})
				await addLink(w.url, newName)
				setSel(w.url)
				reload()
			},
		})
		const templates = PROMPT_TEMPLATES.filter((t) => t.kind === kind)
		const templateBtns = templates.map((t) =>
			el("button", {
				class: "llmp-btn",
				text: "+ " + t.name,
				onClick: async () => {
					if (!repo) return
					const w = await createPromptDoc(repo, kind, {name: t.name, text: t.text})
					await addLink(w.url, t.name)
					setSel(w.url)
					reload()
				},
			})
		)
		const importIn = el("input", {
			class: "llmp-input",
			placeholder: "paste a URL to import a shared prompt…",
		})
		importIn.addEventListener("change", async () => {
			const v = importIn.value.trim()
			if (!/^automerge:/i.test(v)) return
			importIn.value = ""
			await addLink(v)
			setSel(v)
			reload()
		})
		const openBtn = el("button", {
			class: "llmp-btn",
			text: "Open folder ↗",
			onClick: () => openFolder(cfg.prompts),
		})

		// A tool can pass its built-in system prompt via `opts.toolPrompt`
		// ({name, text}). Shown read-only with an active dot (active = the tool
		// default, i.e. NO saved prompt selected) and a "Fork & edit" button that
		// creates an editable copy and selects it — overriding the default. The dot
		// refreshes via paintToolCard() whenever the selection changes. System only.
		/** @type {any} */
		let toolCard = null
		const toolPrompt = !isPre && opts && opts.toolPrompt
		if (toolPrompt && toolPrompt.text) {
			const preview = el("pre", {class: "llmp-note"})
			preview.textContent = toolPrompt.text
			preview.style.cssText =
				"max-height:120px;overflow:auto;white-space:pre-wrap;font:11px/1.45 ui-monospace,Menlo,monospace;opacity:0.8;margin:6px 0 0;"
			const pick = el("button", {
				class: "llmp-pp-pick",
				onClick: () => {
					setSel(null) // clicking returns to the tool default
					paint()
				},
			})
			const status = el("span", {class: "llmp-note", style: "margin-left:auto;font-style:italic;white-space:nowrap"})
			const forkBtn = el("button", {
				class: "llmp-btn primary",
				text: "Fork & edit",
				onClick: async () => {
					if (!repo) return
					const name = (toolPrompt.name || "Tool prompt") + " (fork)"
					const w = await createPromptDoc(repo, "system", {name, text: toolPrompt.text})
					await addLink(w.url, name)
					setSel(w.url) // the fork becomes active → overrides the tool default
					reload()
				},
			})
			toolCard = el("div", {class: "llmp-builtin"}, [
				el("div", {class: "llmp-row", style: "align-items:center;gap:8px"}, [
					pick,
					el("b", {text: toolPrompt.name || "Provided by the tool"}),
					status,
					forkBtn,
				]),
				el("p", {class: "llmp-note llmp-explain", text: "The tool's built-in default — active when no saved prompt below is selected. Fork it to make an editable copy that overrides it."}),
				preview,
			])
			paintToolCard = () => {
				const active = !sel()
				pick.textContent = active ? "●" : "○"
				pick.title = active ? "Active (tool default)" : "Click to use the tool default"
				status.textContent = active ? "active — default" : "overridden ↓"
				toolCard.classList.toggle("active", active)
			}
		}

		wrap.append(
			el("label", {class: "llmp-label"}, [
				header,
				el("p", {class: "llmp-note llmp-explain", text: note}),
				...(toolCard ? [toolCard] : []),
				list,
				empty,
				el("div", {class: "llmp-row"}, [newBtn, ...templateBtns, openBtn]),
				importIn,
			]),
			editorBox
		)
		reload()
	}

	// ---- Tools section ----
	function renderToolsSection() {
		const repo = typeof window !== "undefined" ? window.repo : null
		const wrap = el("div", {class: "llmp-body"})
		content.append(wrap)

		const urlInput = el("input", {
			class: "llmp-input",
			placeholder: "automerge:… (paste an llm:tool URL)",
		})
		const list = el("div", {class: "llmp-tools"})
		const tryBox = el("div")

		/**
		 * @param {string} url
		 * @param {string} [name]
		 */
		async function addLink(url, name) {
			if (!repo || !url) return
			cfg.tools = await ensureFolderUrl(repo, cfg.tools, "Tool Calls")
			await addToFolder(repo, cfg.tools, {name: name || "Tool Call", type: "llm:tool", url})
			reload()
		}
		const addBtn = el("button", {
			class: "llmp-btn",
			text: "Add",
			onClick: async () => {
				const url = urlInput.value.trim()
				urlInput.value = ""
				await addLink(url)
			},
		})
		const newBtn = el("button", {
			class: "llmp-btn primary",
			text: "New tool call",
			onClick: async () => {
				if (!repo) return
				const h = await createLLMTool(repo)
				await addLink(h.url, h.doc()?.name || "New tool call")
			},
		})
		const openBtn = el("button", {
			class: "llmp-btn",
			text: "Open folder ↗",
			onClick: () => openFolder(cfg.tools),
		})

		let tools = []
		async function reload() {
			tools = repo ? await resolveTools(cfg, repo) : []
			openBtn.disabled = !cfg.tools
			list.replaceChildren()
			for (const t of tools) {
				const card = el("div", {class: "llmp-tool-card"})
				list.append(card)
				renderToolCard(card, t.url, repo, reload)
			}
			renderTry()
		}
		function renderTry() {
			tryBox.replaceChildren()
			if (!tools.length) return
			const tryInput = el("input", {class: "llmp-input", placeholder: "Ask something that needs a tool call…"})
			const tryOut = el("pre", {class: "llmp-tryout"})
			const runBtn = el("button", {
				class: "llmp-btn primary",
				text: "Run",
				onClick: async () => {
					if (!tryInput.value.trim()) return
					runBtn.disabled = true
					tryOut.textContent = "…"
					try {
						await generateWithTools(tryInput.value, /** @type {any} */ ({
							config: baseCfg, // raw target — a Proxy can't be postMessage'd to the worker
							onToken: (/** @type {any} */ _d, /** @type {any} */ full) => (tryOut.textContent = full),
							onToolCall: (/** @type {any} */ c) => {
								tryOut.textContent +=
									`\n\n▶ ${c.name}(${JSON.stringify(c.args)}) → ` +
									(c.error ? "⚠ " + c.error : JSON.stringify(c.result)) +
									"\n"
							},
						}))
					} catch (/** @type {any} */ e) {
						tryOut.textContent = "Error: " + (e?.message || e)
					}
					runBtn.disabled = false
				},
			})
			tryBox.append(
				el("label", {class: "llmp-label"}, [
					"Try it",
					el("div", {class: "llmp-row"}, [tryInput, runBtn]),
				]),
				tryOut
			)
		}

		// Built-in tools the host has already wired in (e.g. duet's fetch / ask_*).
		// Read-only — shown so you can see what this model already has.
		const builtin = Array.isArray(opts.tools) ? opts.tools : []
		const builtinGroup = builtin.length
			? el("label", {class: "llmp-label"}, [
					"Built-in tool calls",
					el("p", {
						class: "llmp-note llmp-explain",
						text: "Provided by this tool — always available to the model, not editable here.",
					}),
					el(
						"div",
						{class: "llmp-builtins"},
						builtin.map((t) =>
							el("div", {class: "llmp-builtin"}, [
								el("b", {text: t.name + (t.args ? "(" + t.args + ")" : "")}),
								el("span", {class: "llmp-note", text: t.description || t.desc || ""}),
							])
						)
					),
			  ])
			: null

		// Sandbox toggle: run folder-tool handlers in an isolated Worker (no page
		// access). Autosaved to the config (cfg.toolSandbox), so the "Try it" runner
		// and every generateWithTools call honour it.
		const sandboxCb = el("input", {type: "checkbox"})
		sandboxCb.checked = !!cfg.toolSandbox
		sandboxCb.addEventListener("change", () => (cfg.toolSandbox = sandboxCb.checked))
		const sandboxToggle = el(
			"label",
			{
				class: "llmp-label",
				style: "flex-direction: row; align-items: center; gap: 8px; color: var(--ink);",
			},
			[sandboxCb, el("span", {text: "Run handlers in a sandbox (no page access)"})]
		)
		const sandboxNote = el("p", {
			class: "llmp-note llmp-explain",
			text: "Runs each tool call's JS in an isolated Worker with no access to this page, your repo, or your account — safer for tool calls added by URL. Off = handlers run on the page with full access (needed for tool calls that read/write documents or the DOM).",
		})

		// Tools the host tool itself provides (opts.toolTools: [{name, description,
		// defaultOff?}]). Read-only — their handlers live in the tool — but each can
		// be toggled; cfg.toolToggles[name] decides what's offered to the model. A
		// `defaultOff` tool is off until toggled on.
		let providedCard = null
		const provided = (opts && opts.toolTools) || []
		if (provided.length) {
			if (!cfg.toolToggles) cfg.toolToggles = {}
			const rows = provided.map((/** @type {{name: string, description?: string, defaultOff?: boolean}} */ t) => {
				const cb = el("input", {type: "checkbox"})
				cb.checked = t.defaultOff ? cfg.toolToggles[t.name] === true : cfg.toolToggles[t.name] !== false
				cb.addEventListener("change", () => {
					cfg.toolToggles = {...(cfg.toolToggles || {}), [t.name]: cb.checked}
				})
				return el("label", {class: "llmp-pp-row", style: "display:flex;align-items:flex-start;gap:8px;cursor:var(--studio-cursor-pointer, pointer)"}, [
					cb,
					el("div", {}, [
						el("b", {text: t.name}),
						t.description
							? el("p", {class: "llmp-note", style: "margin:2px 0 0"}, [t.description])
							: null,
					]),
				])
			})
			providedCard = el("div", {class: "llmp-builtin"}, [
				el("b", {text: (opts.toolName ? opts.toolName + " — " : "") + "Built-in tool calls"}),
				el("p", {class: "llmp-note llmp-explain", text: "Tool calls this tool gives the model. Toggle one off to stop offering it."}),
				...rows,
			])
		}

		wrap.append(
			...[
				providedCard,
				builtinGroup,
				el("p", {
					class: "llmp-note llmp-explain",
					text: "Tool calls you give the model: a name, a description of how/when to use it + its parameters, and a JS handler (edited with the file tool). They live in a folder you can open and manage.",
				}),
				sandboxToggle,
				sandboxNote,
				el("div", {class: "llmp-row"}, [urlInput, addBtn, newBtn, openBtn]),
				list,
				tryBox,
			].filter(Boolean)
		)
		reload()
	}

	/**
	 * @param {any} card
	 * @param {string} url
	 * @param {any} repo
	 * @param {() => void} [reload]
	 */
	async function renderToolCard(card, url, repo, reload) {
		if (!repo) return
		let handle
		try {
			handle = await repo.find(url)
		} catch {
			card.append(el("p", {class: "llmp-warn", text: "⚠ Couldn't load " + url}))
			return
		}
		const doc = handle.doc() || {}
		const nameInput = el("input", {
			class: "llmp-input",
			placeholder: "tool call name",
			onInput: (/** @type {any} */ e) => handle.change((/** @type {any} */ d) => (d.name = e.currentTarget.value)),
		})
		nameInput.value = doc.name || ""
		const desc = el("textarea", {
			class: "llmp-input llmp-textarea",
			placeholder: "How/when to use it + its parameters…",
			onInput: (/** @type {any} */ e) => handle.change((/** @type {any} */ d) => (d.description = e.currentTarget.value)),
		})
		desc.value = doc.description || ""
		const copyBtn = el("button", {
			class: "llmp-btn",
			text: "Copy URL",
			onClick: () => {
				navigator.clipboard?.writeText(url)
				copyBtn.textContent = "Copied!"
				setTimeout(() => (copyBtn.textContent = "Copy URL"), 1200)
			},
		})
		const removeBtn = el("button", {
			class: "llmp-btn",
			text: "Remove",
			onClick: async () => {
				if (cfg.tools) await removeFromFolder(repo, cfg.tools, url)
				reload?.()
			},
		})
		/** @type {any} */
		let view = null
		const editBtn = el("button", {
			class: "llmp-btn",
			text: "Edit handler",
			onClick: () => {
				if (view) {
					view.remove()
					view = null
					editBtn.textContent = "Edit handler"
					return
				}
				const d = handle.doc()
				const handlerUrl = d?.tool ?? d?.handlerUrl // `tool`, or legacy `handlerUrl`
				if (!handlerUrl) return
				view = document.createElement("patchwork-view")
				view.setAttribute("doc-url", handlerUrl) // the JS handler file doc
				view.setAttribute("tool-id", "file")
				view.className = "llmp-handler"
				card.append(view)
				editBtn.textContent = "Hide handler"
			},
		})
		card.append(
			el("div", {class: "llmp-row"}, [nameInput, copyBtn]),
			desc,
			el("div", {class: "llmp-row"}, [editBtn, removeBtn])
		)
	}

	// ---- assemble: header + (sidebar | content) + footer ----
	const sideNav = el("div", {class: "llmp-side"})
	const content = el("div", {class: "llmp-content"})
	let section = "model"
	function renderNav() {
		sideNav.replaceChildren(
			...SECTIONS.map((s) =>
				el("button", {
					class: section === s.id ? "active" : "",
					text: s.label,
					onClick: () => {
						section = s.id
						renderNav()
						renderSection()
					},
				})
			)
		)
	}
	function renderSection() {
		content.replaceChildren()
		if (section === "params") renderParamsSection()
		else if (section === "prompts") renderPromptsSection()
		else if (section === "tools") renderToolsSection()
		else {
			content.append(recentBar, tabsBar, body)
			renderRecent()
			renderTabs()
			renderBody()
		}
	}

	// The status bar (config-doc URL) is built once by buildScopedPicker, not
	// per scope editor. See statusBar().
	host.append(el("div", {class: "llmp-main"}, [sideNav, content]))

	renderNav()
	renderSection()
	return {commit, revert, cancel}
}

// The bottom status bar: the URL of the config doc being edited (the account
// settings doc by default, or `source.url` when a host scopes it). Rendered once
// at the bottom of the modal, below every scope editor.
/** @param {PickerOpts} opts */
function statusBar(opts) {
	const configUrl = opts.source?.url || settingsDocHandle()?.url || null
	return el("div", {class: "llmp-statusbar"}, [
		el("span", {class: "llmp-statusbar-label", text: "config"}),
		el("code", {
			class: "llmp-statusbar-url",
			text: configUrl || "(unsaved)",
			title: configUrl || "",
		}),
		configUrl
			? el("button", {
					class: "llmp-statusbar-copy",
					title: "Copy config URL",
					text: "⧉",
					onClick: () => navigator.clipboard?.writeText(configUrl),
			  })
			: null,
	])
}

const spinner = () => el("div", {class: "llmp-loading"}, [el("div", {class: "llmp-spinner"})])

// Build the picker into `mount`, optionally with a whole-scope switcher. When
// `opts.scope = {toolId, docId?, toolName?, docName?}` is given, a Default · This
// tool · This doc bar swaps which config the editor edits: a scope either has its
// own complete override or inherits the default. Returns a getter for the live
// controller (commit/revert target the active scope's editor). No scope → plain.
/**
 * @param {HTMLElement} mount
 * @param {PickerOpts} opts
 * @param {() => void} onRequestClose
 * @returns {() => Ctl|null}
 */
function buildScopedPicker(mount, opts, onRequestClose) {
	/** @type {Ctl|null} */
	let ctl = null
	const getCtl = () => ctl
	// The scope switcher is shown only when a tool opts in: it must pass a `scope`
	// AND not disable the panel (`scopePanel: false`). Without it we render a plain
	// picker that edits the default config (or the caller's `source`).
	const showPanel = !!(opts.scope && opts.scope.toolId && opts.scopePanel !== false)
	if (!showPanel) {
		ctl = buildPickerInto(mount, {...opts, onRequestClose})
		mount.append(statusBar(opts))
		return getCtl
	}
	const scope = /** @type {NonNullable<PickerOpts["scope"]>} */ (opts.scope)

	const scopeFor = (/** @type {string} */ which) =>
		which === "doc"
			? {toolId: scope.toolId, docId: scope.docId}
			: {toolId: scope.toolId}
	const sourceFor = (/** @type {string} */ which) => {
		if (which === "default")
			return opts.source || {read: () => readConfig(), write: (/** @type {any} */ n) => writeConfig(n)}
		const sc = scopeFor(which)
		return {read: () => readScopedConfig(sc), write: (/** @type {any} */ n) => writeScopeOverride(sc, n)}
	}

	// Open on the most-specific scope that already has its own settings — so the
	// modal shows what's actually in effect for this tool/doc, not always Default.
	const initialActive = () => {
		const raw = readConfig()
		if (scope.docId && hasScopeOverride(raw, scopeFor("doc"))) return "doc"
		if (hasScopeOverride(raw, scopeFor("tool"))) return "tool"
		return "default"
	}
	let active = initialActive() // "default" | "tool" | "doc"

	const bar = el("div", {
		class: "llmp-row",
		style: "padding:8px 12px;gap:6px;align-items:center;flex-wrap:wrap;border-bottom:var(--studio-border-width, 1px) var(--studio-border-style, solid) var(--line,rgba(128,128,128,0.25))",
	})
	const bodyHost = el("div", {class: "llmp-scopebody"})
	mount.replaceChildren(bar, bodyHost, statusBar(opts))

	function rebuild() {
		// Flush any pending edit of the scope we're leaving before swapping.
		try { ctl && ctl.commit && ctl.commit() } catch {}
		const mkBtn = (/** @type {string} */ id, /** @type {string} */ label) =>
			el("button", {
				class: "llmp-scopebtn" + (active === id ? " active" : ""),
				text: label,
				onClick: () => { active = id; rebuild() },
			})
		bar.replaceChildren(
			...[
				el("span", {class: "llmp-note", text: "Settings for"}),
				mkBtn("default", "Default"),
				mkBtn("tool", scope.toolName || "This tool"),
				scope.docId ? mkBtn("doc", scope.docName || "This doc") : null,
			].filter(Boolean)
		)

		bodyHost.replaceChildren()
		if (active === "default") {
			ctl = buildPickerInto(bodyHost, {...opts, source: sourceFor("default"), onRequestClose})
			return
		}
		const sc = scopeFor(active)
		if (!hasScopeOverride(readConfig(), sc)) {
			ctl = null
			const what = active === "doc" ? "This document" : "“" + (scope.toolName || "This tool") + "”"
			bodyHost.append(
				el("div", {class: "llmp-body"}, [
					el("p", {class: "llmp-note llmp-explain", text: what + " inherits the default settings."}),
					el("button", {
						class: "llmp-btn primary",
						text: "Create separate settings",
						onClick: () => { writeScopeOverride(sc); rebuild() },
					}),
				])
			)
			return
		}
		const editorHost = el("div", {class: "llmp-scopebody"})
		const resetRow = el("div", {class: "llmp-row", style: "padding:8px 12px"}, [
			el("button", {
				class: "llmp-btn",
				text: "Reset to default (remove these settings)",
				// Drop the editor's pending write FIRST (cancel, not commit/revert —
				// either would re-write the override we're about to delete), then null
				// `ctl` so rebuild()'s leading commit can't resurrect it either.
				onClick: () => {
					try { ctl && ctl.cancel && ctl.cancel() } catch {}
					ctl = null
					clearScopeOverride(sc)
					active = "default"
					rebuild()
				},
			}),
		])
		bodyHost.append(resetRow, editorHost)
		ctl = buildPickerInto(editorHost, {...opts, source: sourceFor(active), onRequestClose})
	}
	rebuild()
	return getCtl
}

/**
 * The config picker as a BARE inline element (no popover, no header/footer) — for
 * a tool to embed and own. Returned synchronously, Suspense-style: it shows a
 * spinner and fills in once config resolves (no defaults-flash).
 *
 *   const panel = llm.dom({source, tools})
 *   box.append(panel)
 *
 * Scope which config it edits with `{source:{read,write,url?}}` (url shows in the
 * status bar). Pass `{tools:[{name,description}]}` to surface the host's built-in
 * tools in the Tools section. The element carries `.result` (resolves on
 * `.destroy()`), `.destroy()` (flush + remove), `.revert()` (revert + remove).
 *
 * @param {PickerOpts} [opts]
 * @returns {HTMLElement}
 */
export function dom(opts = {}) {
	injectStyles()
	const root = el("div", {class: "llmp llmp--bare", role: "group"})
	root.append(spinner())
	/** @type {(v: any) => void} */
	let resolveResult
	root.result = new Promise((r) => (resolveResult = r))
	/** @type {Ctl|null} */
	let ctl = null
	let done = false
	/** @type {() => Ctl|null} */
	let getCtl = () => ctl
	const finish = (/** @type {any} */ saved) => {
		if (done) return
		done = true
		resolveResult(saved)
		root.remove()
	}
	root.destroy = () => { const c = getCtl(); finish(c ? c.commit() : null) }
	root.revert = () => {
		getCtl()?.revert()
		finish(null)
	}
	const start = () => {
		root.replaceChildren()
		getCtl = buildScopedPicker(root, opts, () => root.destroy())
	}
	if (opts.source) start()
	else ensureSettingsDoc().then(start)
	return root
}

/**
 * The config picker wrapped in an outer popover frame (title + ×, Cancel/Done).
 * Returned synchronously; mount it and show it:
 *
 *   const el = llm.popup(); root.append(el); el.showPopover()
 *   const cfg = await el.result   // resolves on close (null if cancelled)
 *
 * Same options as `dom()`. Changes autosave live; Done keeps them, Cancel reverts
 * to the open-time snapshot, light-dismiss keeps them.
 *
 * @param {PickerOpts} [opts]
 * @returns {HTMLElement}
 */
export function popup(opts = {}) {
	injectStyles()
	const frame = el("div", {class: "llmp", popover: "auto", role: "dialog"})
	frame.append(spinner())
	/** @type {(v: any) => void} */
	let resolveResult
	frame.result = new Promise((r) => (resolveResult = r))
	/** @type {Ctl|null} */
	let ctl = null
	/** @type {() => Ctl|null} */
	let getCtl = () => ctl
	let done = false
	let reverting = false
	const finalize = () => {
		if (done) return
		done = true
		const c = getCtl()
		resolveResult(reverting ? null : c ? c.commit() : null)
		frame.remove()
	}
	const close = () => {
		if (frame.matches(":popover-open")) frame.hidePopover()
		else finalize()
	}
	const cancel = () => {
		reverting = true
		getCtl()?.revert()
		close()
	}
	const onEsc = (/** @type {KeyboardEvent} */ e) => {
		if (e.key === "Escape") { e.stopPropagation(); close() }
	}
	frame.addEventListener("toggle", (/** @type {any} */ e) => {
		if (e.newState === "open") window.addEventListener("keydown", onEsc)
		else { window.removeEventListener("keydown", onEsc); finalize() }
	})
	const start = () => {
		const inner = el("div", {class: "llmp-inner"})
		frame.replaceChildren(
			el("div", {class: "llmp-header"}, [
				el("span", {text: "Large Language Model"}),
				el("button", {class: "llmp-close", text: "×", onClick: close}),
			]),
			inner,
			el("div", {class: "llmp-footer"}, [
				el("button", {class: "llmp-btn", text: "Cancel", onClick: cancel}),
				el("button", {class: "llmp-btn primary", text: "Done", onClick: close}),
			])
		)
		getCtl = buildScopedPicker(inner, opts, close)
	}
	if (opts.source) start()
	else ensureSettingsDoc().then(start)
	return frame
}

export {describeConfig}
