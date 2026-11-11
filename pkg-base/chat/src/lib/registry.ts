// @ts-ignore — resolved at runtime from the host importmap (bootloader externals)
import {getRegistry} from "@inkandswitch/patchwork-plugins"

// Re-export so slot loading (lib/slots.ts) can reach the raw registry for
// `.get(id)` / `.load(id)` / event subscription without re-importing the extern.
export {getRegistry}

// Return the currently-registered entry for a plugin id (description before load,
// or `{...meta, module}` after), or undefined. Never throws.
export function getPlugin(type: string, id: string): any | undefined {
	try {
		return getRegistry(type)?.get?.(id)
	} catch {
		return undefined
	}
}

// Load a registry plugin's implementation on demand — resolves the description's
// `load()` and returns `{...meta, module}` (the host caches it). Returns null if
// the id isn't registered or can't load. This is how cross-bundle behaviour
// (e.g. a chitter feature's slot renderers) reaches the base at runtime.
export async function loadPlugin(type: string, id: string): Promise<any | null> {
	try {
		const reg: any = getRegistry(type)
		if (!reg?.load) return null
		return (await reg.load(id)) ?? null
	} catch {
		return null
	}
}

// Subscribe to registry mutations for a type (a bundle registering/loading its
// plugins after we've mounted). Returns an unsubscribe fn; no-ops if unsupported.
export function onRegistryChange(type: string, cb: () => void): () => void {
	try {
		const reg: any = getRegistry(type)
		if (!reg?.on) return () => {}
		const off = reg.on("changed", cb)
		return typeof off === "function" ? off : () => reg.off?.("changed", cb)
	} catch {
		return () => {}
	}
}

// Enumerate host-registered plugins of a given type. Mirrors newspace's
// `list(type)` helper (newspace/src/layers.js): the registry is asked first, and
// callers pass their own built-ins as a backstop so an empty/absent registry
// never breaks the tool.
export function listPlugins(type: string): any[] {
	try {
		const r: any = getRegistry(type)
		if (!r) return []
		if (typeof r.filter === "function") return r.filter(() => true)
		return Array.isArray(r) ? r : []
	} catch {
		return []
	}
}

// Merge built-in plugins with host-registered ones of the same type, deduped by
// id. Built-ins WIN on id conflict: the registry stores serializable plugin
// *descriptions* (behaviour deferred behind `load()`, exposed under `.module`
// only after loading), whereas the tool consumes behaviour inline off its own
// built-ins (`.transform` / `.run` / `.getEmojis`). Letting a same-id description
// override the built-in would drop that inline behaviour. Registry-only ids
// (third-party contributions) are still surfaced, listed first.
export function mergePlugins(type: string, builtins: any[]): any[] {
	const byId = new Map<string, any>()
	for (const p of listPlugins(type)) if (p && p.id) byId.set(p.id, p)
	for (const p of builtins) if (p && p.id) byId.set(p.id, p)
	return [...byId.values()]
}

export type PluginSelector = "all" | "core" | string[]

// Pick the active plugins for a tool from the merged set, per a feature selector:
//   "all"       → every plugin (built-in + host-contributed)
//   "core"      → only plugins tagged tier:"core"
//   string[]    → only plugins whose id is listed
export function selectPlugins(all: any[], selector: PluginSelector): any[] {
	if (selector === "all") return all
	if (selector === "core") return all.filter((p) => p.tier === "core")
	if (Array.isArray(selector)) return all.filter((p) => selector.includes(p.id))
	return []
}

// The common case: merge built-ins with the registry then select by the tool's
// feature selector — one call.
export function resolvePlugins(
	type: string,
	builtins: any[],
	selector: PluginSelector
): any[] {
	return selectPlugins(mergePlugins(type, builtins), selector)
}
