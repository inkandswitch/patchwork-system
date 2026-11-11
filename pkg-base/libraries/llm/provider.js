/**
 * <patchwork-llm-config-provider> — scope an LLM config to a DOM subtree.
 *
 * Any `@patchwork/llm` consumer inside this element (more precisely: inside a
 * <patchwork-view> that this element wraps) resolves its config from here
 * instead of the account doc. Lets you give one tool/view a different model:
 *
 *   <patchwork-llm-config-provider provider="openrouter" model="anthropic/claude-sonnet-4">
 *     <patchwork-view> … a tool using @patchwork/llm … </patchwork-view>
 *   </patchwork-llm-config-provider>
 *
 * Configure it three ways:
 *   - attributes: `provider`, `model`, `temperature`
 *   - the `.config` property (a full/partial LLM config object)
 *   - `el.configure()` — opens the picker scoped to THIS element (writes back
 *     here, not the account doc), returns a Promise<config|null>
 *
 * A bare provider (no config set) does NOT answer — consumers fall through to
 * the account doc as usual.
 */

import {accept} from "@inkandswitch/patchwork-providers"
import {normalizeConfig, CONFIG_SELECTOR} from "./config.js"
import {dom} from "./picker.js"

const TAG = "patchwork-llm-config-provider"

export class PatchworkLLMConfigProvider extends HTMLElement {
	constructor() {
		super()
		/** @type {import("./config.js").LLMConfig | null} */
		this._config = null // null = "not configured" → don't answer
		this._subs = new Set() // live responders (one per consumer subscription)
		this._onSubscribe = this._onSubscribe.bind(this)
	}

	static get observedAttributes() {
		return ["provider", "model", "temperature"]
	}

	connectedCallback() {
		this.addEventListener("patchwork:subscribe", this._onSubscribe)
	}
	disconnectedCallback() {
		this.removeEventListener("patchwork:subscribe", this._onSubscribe)
	}
	attributeChangedCallback() {
		this._config = this._fromAttrs(this._config ?? {})
		this._emit()
	}

	/** @param {any} base */
	_fromAttrs(base) {
		const raw = {...base}
		const provider = this.getAttribute("provider")
		const model = this.getAttribute("model")
		const temp = this.getAttribute("temperature")
		if (provider) raw.provider = provider
		if (temp != null && temp !== "") raw.temperature = +temp
		if (model && provider) raw[provider] = {...(raw[provider] || {}), model}
		return normalizeConfig(raw)
	}

	/** @param {any} e */
	_onSubscribe(e) {
		if (e.detail?.selector?.type !== CONFIG_SELECTOR.type) return
		if (!this._config) return // not configured — let it bubble to the account doc
		accept(e, (/** @type {(cfg: any) => void} */ respond) => {
			this._subs.add(respond)
			respond(this._config)
			return () => this._subs.delete(respond)
		})
	}
	_emit() {
		if (!this._config) return
		for (const r of this._subs) r(this._config)
	}

	/** @returns {import("./config.js").LLMConfig | null} */
	get config() {
		return this._config
	}
	set config(c) {
		this._config = c ? normalizeConfig(c) : null
		this._emit()
	}

	/** Open the picker scoped to this provider (writes back here). */
	configure() {
		const node = /** @type {any} */ (
			dom({
				source: {
					read: () => this._config ?? normalizeConfig({}),
					write: (/** @type {any} */ cfg) => (this.config = cfg),
				},
			})
		)
		this.appendChild(node) // keep it in this subtree so embedded views get context
		node.showPopover()
		return node.result
	}
}

export function definePatchworkLLMConfigProvider() {
	if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
		customElements.define(TAG, PatchworkLLMConfigProvider)
	}
}

// Auto-register on import so `<patchwork-llm-config-provider>` just works.
definePatchworkLLMConfigProvider()
