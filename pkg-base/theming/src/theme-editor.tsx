import {render} from "solid-js/web"
import {createSignal, createEffect, For, onCleanup, Show} from "solid-js"
import {EDITABLE_VARIABLES, DEFAULT_VALUES, type CustomThemeDoc} from "./theme-editor-datatype.ts"

// Fill offsets keep linear labels (10..50) but the actual mix amount curves:
// finer steps near the fill where the eye is most sensitive, so subtle tints
// (active line, gutter) stay distinct. 10 starts at the fill itself. See theme.css.
const FILL_OFFSET_RAMP: [number, number][] = [[10, 0], [20, 7], [30, 18], [40, 32], [50, 50]]
const LINE_OFFSET_RAMP: [number, number][] = [[10, 8], [20, 18], [30, 33], [40, 52], [50, 76]]

/**
 * Generates the full CSS for a custom theme, including derived offset variables.
 */
export function generateThemeCss(name: string, mode: "light" | "dark", vars: Record<string, string>, customCss?: string): string {
	let css = `[theme="${name}"] {\n`
	css += `\tcolor-scheme: ${mode};\n`

	// Write explicit variables. blank ones stay unset: an empty custom property
	// is still "set", which would beat every var() fallback.
	for (const [key, value] of Object.entries(vars)) {
		if (!value?.trim()) continue
		css += `\t${key}: ${value};\n`
	}

	// Derive fill offsets, tinted toward the secondary (see theme.css)
	for (const [label, amount] of FILL_OFFSET_RAMP) {
		css += `\t--studio-fill-offset-${label}: color-mix(in oklch, color-mix(in oklch, var(--studio-fill), var(--studio-line) ${amount}%), var(--studio-offset-tint, var(--studio-secondary)) var(--studio-offset-tint-amount, 10%));\n`
	}

	// Derive line offsets, tinted toward the secondary (see theme.css)
	for (const [label, amount] of LINE_OFFSET_RAMP) {
		css += `\t--studio-line-offset-${label}: color-mix(in oklch, color-mix(in oklch, var(--studio-line), var(--studio-fill) ${amount}%), var(--studio-offset-tint, var(--studio-secondary)) var(--studio-offset-tint-amount, 10%));\n`
	}

	css += "}\n"

	if (customCss?.trim()) {
		css += `\n/* Custom CSS */\n${customCss}\n`
	}

	return css
}

/**
 * Scan all stylesheets for CSS custom properties defined on :root.
 * Returns a map of variable name -> value, excluding known editable vars.
 */
function discoverRootVariables(): Record<string, string> {
	const knownKeys = new Set(EDITABLE_VARIABLES.flatMap(g => g.vars.map(v => v.key)))
	for (const pct of [10, 20, 30, 40, 50]) {
		knownKeys.add(`--studio-fill-offset-${pct}`)
		knownKeys.add(`--studio-line-offset-${pct}`)
	}

	const found: Record<string, string> = {}

	try {
		for (const sheet of document.styleSheets) {
			try {
				for (const rule of sheet.cssRules) {
					if (!(rule instanceof CSSStyleRule)) continue
					if (rule.selectorText !== ":root") continue
					for (let i = 0; i < rule.style.length; i++) {
						const prop = rule.style[i]
						if (!prop.startsWith("--")) continue
						if (knownKeys.has(prop)) continue
						found[prop] = rule.style.getPropertyValue(prop).trim()
					}
				}
			} catch {
				// cross-origin stylesheet, skip
			}
		}
	} catch {
		// no access to stylesheets
	}

	return found
}

function looksLikeColor(value: string): boolean {
	const v = value.trim().toLowerCase()
	return v.startsWith("#") || v.startsWith("rgb") || v.startsWith("hsl")
		|| v.startsWith("oklch") || v.startsWith("oklab") || v.startsWith("lch")
		|| v.startsWith("lab") || v.startsWith("color(") || v.startsWith("color-mix(")
}

export function ThemeEditorTool(handle: any, element: HTMLElement) {
	const [doc, setDoc] = createSignal<CustomThemeDoc>(handle.doc())
	const onChange = () => setDoc(handle.doc())
	handle.on("change", onChange)

	const [livePreview, setLivePreview] = createSignal(true)

	// Apply live preview by setting vars on documentElement
	createEffect(() => {
		if (!livePreview()) return
		const d = doc()
		if (!d?.variables) return
		const root = document.documentElement
		for (const [key, value] of Object.entries(d.variables)) {
			if (value?.trim()) root.style.setProperty(key, value)
			else root.style.removeProperty(key)
		}
		// Also set derived offsets live
		for (const [label, amount] of FILL_OFFSET_RAMP) {
			root.style.setProperty(
				`--studio-fill-offset-${label}`,
				`color-mix(in oklch, color-mix(in oklch, var(--studio-fill), var(--studio-line) ${amount}%), var(--studio-offset-tint, var(--studio-secondary)) var(--studio-offset-tint-amount, 10%))`
			)
		}
		for (const [label, amount] of LINE_OFFSET_RAMP) {
			root.style.setProperty(
				`--studio-line-offset-${label}`,
				`color-mix(in oklch, color-mix(in oklch, var(--studio-line), var(--studio-fill) ${amount}%), var(--studio-offset-tint, var(--studio-secondary)) var(--studio-offset-tint-amount, 10%))`
			)
		}
	})

	// Clean up live preview on unmount
	onCleanup(() => {
		const root = document.documentElement
		const d = doc()
		if (d?.variables) {
			for (const key of Object.keys(d.variables)) {
				root.style.removeProperty(key)
			}
			for (const pct of [10, 20, 30, 40, 50]) {
				root.style.removeProperty(`--studio-fill-offset-${pct}`)
				root.style.removeProperty(`--studio-line-offset-${pct}`)
			}
		}
	})

	function setVar(key: string, value: string) {
		if (!value.trim()) {
			document.documentElement.style.removeProperty(key)
			handle.change((d: any) => {
				if (d.variables) delete d.variables[key]
			})
			return
		}
		handle.change((d: any) => {
			if (!d.variables) d.variables = {}
			d.variables[key] = value
		})
	}

	function setName(name: string) {
		handle.change((d: any) => {
			d.name = name
		})
	}

	function toggleMode() {
		handle.change((d: any) => {
			d.mode = d.mode === "dark" ? "light" : "dark"
		})
	}

	function setCustomCss(css: string) {
		handle.change((d: any) => {
			d.customCss = css
		})
	}

	function resetToDefaults() {
		handle.change((d: any) => {
			d.variables = {...DEFAULT_VALUES}
		})
	}

	const [rootVars, setRootVars] = createSignal<Record<string, string>>({})
	// Discover :root variables on mount
	setTimeout(() => setRootVars(discoverRootVariables()), 0)

	function exportCss(): string {
		const d = doc()
		return generateThemeCss(d.name?.toLowerCase().replace(/\s+/g, "-") || "custom", d.mode || "light", d.variables || {}, d.customCss)
	}

	// Live preview for custom CSS
	const customCssPreviewEl = document.createElement("style")
	element.appendChild(customCssPreviewEl)
	createEffect(() => {
		if (!livePreview()) {
			customCssPreviewEl.textContent = ""
			return
		}
		customCssPreviewEl.textContent = doc()?.customCss || ""
	})
	onCleanup(() => customCssPreviewEl.remove())

	function copyToClipboard() {
		navigator.clipboard.writeText(exportCss())
	}

	const style = document.createElement("style")
	style.textContent = `
		.theme-editor {
			padding: var(--studio-space-md, 1rem);
			font-family: var(--studio-family-sans, system-ui, sans-serif);
			color: var(--studio-line, black);
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-md, 1rem);
			height: 100%;
			overflow-y: auto;
		}
		.theme-editor .header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: var(--studio-space-sm, 0.5rem);
		}
		.theme-editor .name-input {
			font-size: 1.25rem;
			font-weight: 600;
			border: none;
			border-bottom: 2px solid transparent;
			background: none;
			color: inherit;
			font-family: inherit;
			padding: var(--studio-space-2xs, 0.25rem) 0;
			outline: none;
			flex: 1;
			min-width: 0;
		}
		.theme-editor .name-input:focus {
			border-bottom-color: var(--studio-primary-line, var(--studio-primary, #35f7ca));
		}
		.theme-editor .toolbar {
			display: flex;
			gap: var(--studio-space-xs, 0.375rem);
			align-items: center;
		}
		.theme-editor .btn {
			padding: var(--studio-space-2xs, 0.25rem) var(--studio-space-sm, 0.5rem);
			border-radius: var(--studio-radius-sm, 4px);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			font-size: 0.8rem;
			font-family: inherit;
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-editor .btn:hover {
			background: var(--studio-hover-fill, color-mix(in oklch, var(--studio-fill, white), var(--studio-line, black) 5%));
		}
		.theme-editor .btn[data-active] {
			background: var(--studio-primary-fill, var(--studio-primary, #35f7ca));
			border-color: var(--studio-primary-line, var(--studio-primary, #35f7ca));
			color: var(--studio-primary-line, var(--studio-fill, white));
		}
		.theme-editor .mode-toggle {
			display: flex;
			align-items: center;
			gap: var(--studio-space-2xs, 0.25rem);
			padding: var(--studio-space-2xs, 0.25rem) var(--studio-space-sm, 0.5rem);
			border-radius: var(--studio-radius-sm, 4px);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			font-size: 0.8rem;
			font-family: inherit;
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-editor .mode-toggle:hover {
			background: var(--studio-hover-fill, color-mix(in oklch, var(--studio-fill, white), var(--studio-line, black) 5%));
		}
		.theme-editor .mode-icon {
			font-size: 1em;
			line-height: 1;
		}
		.theme-editor .group {
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-xs, 0.375rem);
		}
		.theme-editor .group-title {
			font-size: 0.75rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.05em);
			color: color-mix(in oklch, var(--studio-line, black), transparent 50%);
		}
		.theme-editor .var-row {
			display: flex;
			align-items: center;
			gap: var(--studio-space-sm, 0.5rem);
		}
		.theme-editor .var-label {
			font-size: 0.8rem;
			min-width: 8rem;
			color: color-mix(in oklch, var(--studio-line, black), transparent 30%);
		}
		.theme-editor .color-input {
			width: 2.5rem;
			height: 2rem;
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			border-radius: var(--studio-radius-sm, 4px);
			padding: 2px;
			cursor: var(--studio-cursor-pointer, pointer);
			background: none;
		}
		.theme-editor .text-input {
			flex: 1;
			min-width: 0;
			padding: var(--studio-space-2xs, 0.25rem) var(--studio-space-xs, 0.375rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			font-size: 0.8rem;
			font-family: inherit;
		}
		.theme-editor .text-input:focus {
			outline: var(--studio-focus-ring, 2px solid var(--studio-primary-line, var(--studio-primary, #35f7ca)));
			outline-offset: var(--studio-focus-ring-offset, 1px);
		}
		.theme-editor .hex-display {
			font-family: var(--studio-family-code, ui-monospace, monospace);
			font-size: 0.75rem;
			color: color-mix(in oklch, var(--studio-line, black), transparent 50%);
			min-width: 5rem;
		}
		.theme-editor .preview {
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			border-radius: var(--studio-radius-md, 8px);
			padding: var(--studio-space-md, 1rem);
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-sm, 0.5rem);
		}
		.theme-editor .preview-title {
			font-size: 0.75rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: var(--studio-chrome-letter-spacing, 0.05em);
			color: color-mix(in oklch, var(--studio-line, black), transparent 50%);
			margin-bottom: var(--studio-space-2xs, 0.25rem);
		}
		.theme-editor .swatch-row {
			display: flex;
			gap: var(--studio-space-2xs, 0.25rem);
			flex-wrap: wrap;
		}
		.theme-editor .swatch {
			width: 2rem;
			height: 2rem;
			border-radius: var(--studio-radius-sm, 4px);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 85%);
		}
		.theme-editor .offset-strip {
			display: flex;
			height: 1.5rem;
			border-radius: var(--studio-radius-sm, 4px);
			overflow: hidden;
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 85%);
		}
		.theme-editor .offset-strip > div {
			flex: 1;
		}
		.theme-editor .export-area {
			font-family: var(--studio-family-code, ui-monospace, monospace);
			font-size: 0.7rem;
			white-space: pre;
			overflow-x: auto;
			background: color-mix(in oklch, var(--studio-fill, white), var(--studio-line, black) 3%);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 85%);
			border-radius: var(--studio-radius-sm, 4px);
			padding: var(--studio-space-sm, 0.5rem);
			max-height: 200px;
			overflow-y: auto;
		}
		.theme-editor .css-textarea {
			font-family: var(--studio-family-code, ui-monospace, monospace);
			font-size: 0.8rem;
			min-height: 6rem;
			resize: vertical;
			padding: var(--studio-space-sm, 0.5rem);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			tab-size: 2;
			white-space: pre;
			overflow-x: auto;
		}
		.theme-editor .css-textarea:focus {
			outline: var(--studio-focus-ring, 2px solid var(--studio-primary-line, var(--studio-primary, #35f7ca)));
			outline-offset: var(--studio-focus-ring-offset, 1px);
		}
		.theme-editor .discovered-label {
			font-family: var(--studio-family-code, ui-monospace, monospace);
			font-size: 0.75rem;
			min-width: 8rem;
			color: color-mix(in oklch, var(--studio-line, black), transparent 30%);
			word-break: break-all;
		}
		.theme-editor .btn-sm {
			padding: 2px var(--studio-space-xs, 0.375rem);
			border-radius: var(--studio-radius-sm, 4px);
			border: var(--studio-border-width, 1px) var(--studio-border-style, solid) color-mix(in oklch, var(--studio-line, black), transparent 80%);
			background: var(--studio-fill, white);
			color: var(--studio-line, black);
			font-size: 0.7rem;
			font-family: inherit;
			cursor: var(--studio-cursor-pointer, pointer);
		}
		.theme-editor .btn-sm:hover {
			background: var(--studio-hover-fill, color-mix(in oklch, var(--studio-fill, white), var(--studio-line, black) 5%));
		}
	`
	element.appendChild(style)

	const dispose = render(() => {
		const vars = () => doc()?.variables || {}

		return (
			<div class="theme-editor">
				<div class="header">
					<input
						class="name-input"
						value={doc()?.name || ""}
						onInput={(e) => setName(e.currentTarget.value)}
						placeholder="Theme name"
					/>
					<div class="toolbar">
						<button class="mode-toggle" onClick={toggleMode}>
							<span class="mode-icon">{(doc()?.mode || "light") === "dark" ? "\u{263E}" : "\u{2600}"}</span>
							{(doc()?.mode || "light") === "dark" ? "Dark" : "Light"}
						</button>
						<button
							class="btn"
							data-active={livePreview() ? "" : undefined}
							onClick={() => setLivePreview(!livePreview())}
						>
							{livePreview() ? "Live" : "Paused"}
						</button>
						<button class="btn" onClick={resetToDefaults}>
							Reset
						</button>
						<button class="btn" onClick={copyToClipboard}>
							Copy CSS
						</button>
					</div>
				</div>

				{/* Preview strip */}
				<div class="preview">
					<div class="preview-title">Preview</div>
					<div class="swatch-row">
						<div class="swatch" style={{background: vars()["--studio-fill"] || "#fff"}} />
						<div class="swatch" style={{background: vars()["--studio-line"] || "#000"}} />
						<div class="swatch" style={{background: vars()["--studio-primary"] || "#35f7ca"}} />
						<div class="swatch" style={{background: vars()["--studio-secondary"] || "#33ccf8"}} />
						<div class="swatch" style={{background: vars()["--studio-danger"] || "#ff6a90"}} />
						<div class="swatch" style={{background: vars()["--studio-warning"] || "#f8c43b"}} />
						<div class="swatch" style={{background: vars()["--studio-added"] || "#35f7ca"}} />
						<div class="swatch" style={{background: vars()["--studio-link"] || "#36e"}} />
					</div>
					<div class="preview-title" style={{"margin-top": "0.5rem"}}>Fill offsets</div>
					<div class="offset-strip">
						<div style={{background: vars()["--studio-fill"] || "#fff"}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-fill"] || "#fff"}, ${vars()["--studio-line"] || "#000"} 10%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-fill"] || "#fff"}, ${vars()["--studio-line"] || "#000"} 20%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-fill"] || "#fff"}, ${vars()["--studio-line"] || "#000"} 30%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-fill"] || "#fff"}, ${vars()["--studio-line"] || "#000"} 40%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-fill"] || "#fff"}, ${vars()["--studio-line"] || "#000"} 50%)`}} />
					</div>
					<div class="preview-title">Line offsets</div>
					<div class="offset-strip">
						<div style={{background: vars()["--studio-line"] || "#000"}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-line"] || "#000"}, ${vars()["--studio-fill"] || "#fff"} 10%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-line"] || "#000"}, ${vars()["--studio-fill"] || "#fff"} 20%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-line"] || "#000"}, ${vars()["--studio-fill"] || "#fff"} 30%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-line"] || "#000"}, ${vars()["--studio-fill"] || "#fff"} 40%)`}} />
						<div style={{background: `color-mix(in oklch, ${vars()["--studio-line"] || "#000"}, ${vars()["--studio-fill"] || "#fff"} 50%)`}} />
					</div>
				</div>

				{/* Variable editors */}
				<For each={EDITABLE_VARIABLES}>
					{(group) => (
						<div class="group">
							<div class="group-title">{group.group}</div>
							<For each={group.vars}>
								{(v) => (
									<div class="var-row">
										<span class="var-label">{v.label}</span>
										<Show when={v.type === "color"}>
											<input
												class="color-input"
												type="color"
												value={vars()[v.key] || DEFAULT_VALUES[v.key] || "#000000"}
												onInput={(e) => setVar(v.key, e.currentTarget.value)}
											/>
											<span class="hex-display">
												{vars()[v.key] || DEFAULT_VALUES[v.key]}
											</span>
										</Show>
										<Show when={v.type === "text"}>
											<input
												class="text-input"
												type="text"
												value={vars()[v.key] || DEFAULT_VALUES[v.key] || ""}
												placeholder={v.placeholder}
												onInput={(e) => setVar(v.key, e.currentTarget.value)}
											/>
										</Show>
									</div>
								)}
							</For>
						</div>
					)}
				</For>

				{/* Discovered :root variables */}
				<Show when={Object.keys(rootVars()).length > 0}>
					<div class="group">
						<div class="group-title">Discovered :root variables</div>
						<For each={Object.entries(rootVars())}>
							{([key, defaultValue]) => (
								<div class="var-row">
									<span class="discovered-label">{key}</span>
									<Show when={looksLikeColor(vars()[key] || defaultValue)}>
										<input
											class="color-input"
											type="color"
											value={vars()[key] || defaultValue}
											onInput={(e) => setVar(key, e.currentTarget.value)}
										/>
										<span class="hex-display">
											{vars()[key] || defaultValue}
										</span>
									</Show>
									<Show when={!looksLikeColor(vars()[key] || defaultValue)}>
										<input
											class="text-input"
											type="text"
											value={vars()[key] || defaultValue}
											onInput={(e) => setVar(key, e.currentTarget.value)}
										/>
									</Show>
									<Show when={!vars()[key]}>
										<button class="btn-sm" onClick={() => setVar(key, defaultValue)}>
											Override
										</button>
									</Show>
								</div>
							)}
						</For>
					</div>
				</Show>

				{/* Custom CSS */}
				<div class="group">
					<div class="group-title">Custom CSS</div>
					<textarea
						class="css-textarea"
						value={doc()?.customCss || ""}
						onInput={(e) => setCustomCss(e.currentTarget.value)}
						placeholder={"/* Additional CSS rules */\n[theme=\"my-theme\"] .some-element {\n  color: red;\n}"}
					/>
				</div>

				{/* Export */}
				<div class="group">
					<div class="group-title">Generated CSS</div>
					<pre class="export-area">{exportCss()}</pre>
				</div>
			</div>
		)
	}, element)

	return () => {
		handle.off("change", onChange)
		// Remove live preview styles
		const root = document.documentElement
		const d = doc()
		if (d?.variables) {
			for (const key of Object.keys(d.variables)) {
				root.style.removeProperty(key)
			}
			for (const pct of [10, 20, 30, 40, 50]) {
				root.style.removeProperty(`--studio-fill-offset-${pct}`)
				root.style.removeProperty(`--studio-line-offset-${pct}`)
			}
		}
		dispose()
		style.remove()
	}
}
