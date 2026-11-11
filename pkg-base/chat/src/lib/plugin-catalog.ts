// The plugin catalog — the single place that knows about every plugin type and
// can enumerate ids/tiers across all of them. Used to:
//   - seed a doc's `plugins` array at creation (the datatype presets)
//   - resolve a doc's `plugins` array into the active feature id set (core-tier is
//     ALWAYS on; full-tier is opt-in, listed explicitly in `doc.plugins`)
//   - drive the `/plugin` command + panel
//
// The document's `plugins` array is the truth. `expandSelector` maps that array (or an explicit override
// from the embeddable component) onto the concrete set of active plugin ids.

import {mergePlugins, type PluginSelector} from "./registry"
import {featurePlugins} from "../features"
import {syntaxPlugins} from "./syntax"
import {slashPlugins} from "./slash-plugins"
import {messageActionPlugins} from "./message-actions"
import {emojiPackPlugins} from "./emoji-packs"

// Every plugin type this tool tiers over, paired with its built-in declarations.
export const BUILTIN_PLUGIN_TYPES: {type: string; builtins: any[]}[] = [
	{type: "chat:feature", builtins: featurePlugins},
	{type: "chat:syntax", builtins: syntaxPlugins},
	{type: "chat:slash", builtins: slashPlugins},
	{type: "chat:messageaction", builtins: messageActionPlugins},
	{type: "chat:emojipack", builtins: emojiPackPlugins},
]

// Every known plugin (built-in merged with host-registered), across all types.
function allPlugins(): any[] {
	const out: any[] = []
	for (const {type, builtins} of BUILTIN_PLUGIN_TYPES) {
		out.push(...mergePlugins(type, builtins))
	}
	return out
}

// Core-tier ids (registry-aware) — always active regardless of `doc.plugins`.
export function coreIds(): Set<string> {
	const s = new Set<string>()
	for (const p of allPlugins()) if (p?.tier === "core" && p.id) s.add(p.id)
	return s
}

// Full-tier ids (registry-aware) — the opt-in set that "all" expands to.
export function allFullIds(): string[] {
	const out: string[] = []
	for (const p of allPlugins()) if (p?.tier === "full" && p.id) out.push(p.id)
	return out
}

// Full-tier ids from the BUILT-INS only (deterministic, no registry). This is
// what the `chitterchatter` datatype seeds into a new doc's `plugins` array, so
// creation is reproducible and the array is self-describing.
export const BUILTIN_FULL_IDS: string[] = BUILTIN_PLUGIN_TYPES.flatMap(({builtins}) =>
	builtins.filter((p: any) => p?.tier === "full" && p.id).map((p: any) => p.id as string)
)

export interface CatalogEntry {
	id: string
	type: string
	name: string
	tier: "core" | "full"
}

// One entry per known plugin id (deduped), for the `/plugin` panel.
export function pluginCatalog(): CatalogEntry[] {
	const out: CatalogEntry[] = []
	const seen = new Set<string>()
	for (const {type, builtins} of BUILTIN_PLUGIN_TYPES) {
		for (const p of mergePlugins(type, builtins)) {
			if (!p?.id || seen.has(p.id)) continue
			seen.add(p.id)
			out.push({
				id: p.id,
				type: p.type || type,
				name: p.name || p.id,
				tier: p.tier === "core" ? "core" : "full",
			})
		}
	}
	return out
}

// A document's effective selector. An explicit `plugins` array is honored as-is
// (including empty → core only). A MISSING array means a legacy doc created before
// `plugins` existed — default those to "all" so every pre-existing chat keeps all
// its features. New docs always have an array.
export function docSelector(doc: {plugins?: string[]} | undefined | null): PluginSelector {
	return Array.isArray(doc?.plugins) ? (doc!.plugins as string[]) : "all"
}

// Resolve a selector into the set of active plugin ids. The selector is either a
// document's `plugins` array, or an explicit override from the embeddable
// component ("all" | "core" | id list). Core-tier is always included.
export function expandSelector(sel: PluginSelector | undefined): Set<string> {
	const set = coreIds()
	if (sel === "all") {
		for (const id of allFullIds()) set.add(id)
	} else if (Array.isArray(sel)) {
		for (const id of sel) set.add(id)
	}
	// "core" | undefined → core-tier only
	return set
}
