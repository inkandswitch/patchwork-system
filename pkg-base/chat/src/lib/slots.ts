// Render-slot resolution. A `chat:feature` plugin may fill named extension slots
// with Solid components. The base ChatRoot defines the slot mount points; features
// (built-in, or contributed by another bundle like `chitter` through the registry)
// supply the components. This is the seam that lets feature UI physically live in a
// separate bundle while the base tool still works standalone.
//
// Two delivery paths, in priority order (see lib/registry `getPlugin`/`loadPlugin`):
//   1. inline `.slots` on the plugin object — the owning bundle's own built-ins
//   2. `.module.slots` after `registry.load(id)` — a cross-bundle contribution,
//      whose function fields ride behind `async load()` (the DataClone-safe pattern)

import {createSignal, createEffect, onCleanup, type Accessor} from "solid-js"
import {featurePlugins} from "../features"
import {
	resolvePlugins,
	getPlugin,
	loadPlugin,
	onRegistryChange,
	type PluginSelector,
} from "./registry"

// A slot renderer is authored against the explicit SlotContext (never useContext —
// context identity differs across bundles). `extra` carries mount-point-local data
// (the message for a reaction slot, the input caps for an input-actions slot).
export type SlotRenderer = (ctx: any, extra?: any) => any

export interface SlotEntry {
	featureId: string
	slot: string
	render: SlotRenderer
}

const FEATURE_TYPE = "chat:feature"

// Resolve a single active feature plugin's slot map (inline, else loaded module).
async function slotsForFeature(
	p: any,
	cache: Map<string, Record<string, SlotRenderer> | null>
): Promise<Record<string, SlotRenderer> | null> {
	if (cache.has(p.id)) return cache.get(p.id)!
	if (p?.slots && typeof p.slots === "object") {
		cache.set(p.id, p.slots)
		return p.slots
	}
	// Already-loaded registry module?
	const existing = getPlugin(FEATURE_TYPE, p.id)
	if (existing?.module?.slots) {
		cache.set(p.id, existing.module.slots)
		return existing.module.slots
	}
	// Load on demand (cross-bundle contribution).
	const loaded = await loadPlugin(FEATURE_TYPE, p.id)
	const slots = loaded?.module?.slots ?? null
	cache.set(p.id, slots)
	return slots
}

// Reactive resolved-plugin list for a seam whose behaviour is function-valued
// (chat:slash `transform`, chat:messageaction `run`/`show`). Built-ins carry their
// behaviour inline; a cross-bundle contribution (e.g. chitter) arrives as a
// description whose functions ride behind `async load()`. This flattens each
// active plugin's behaviour up to the top level — inline for own built-ins, from
// the loaded `.module` for registry contributions — so consumers can call
// `plugin.transform`/`plugin.run` synchronously. Re-runs on selector change and
// when the registry mutates (another bundle registering/loading its plugins).
export function createLoadedPlugins(
	type: string,
	builtins: any[],
	selector: Accessor<PluginSelector>
): Accessor<any[]> {
	const [out, setOut] = createSignal<any[]>([])
	const cache = new Map<string, any>()
	let seq = 0

	const [tick, setTick] = createSignal(0)
	const off = onRegistryChange(type, () => {
		cache.clear()
		setTick((n) => n + 1)
	})
	onCleanup(off)

	createEffect(() => {
		tick()
		const active = resolvePlugins(type, builtins, selector())
		const mySeq = ++seq
		Promise.all(
			active.map(async (p) => {
				if (cache.has(p.id)) return cache.get(p.id)
				let merged = p
				if (p.module) merged = {...p, ...p.module}
				else if (typeof p.load === "function") {
					const loaded = await loadPlugin(type, p.id)
					if (loaded?.module) merged = {...loaded, ...loaded.module}
				}
				cache.set(p.id, merged)
				return merged
			})
		).then((list) => {
			if (mySeq === seq) setOut(list)
		})
	})

	return out
}

// Reactive slotId → SlotEntry[] map for the currently-active feature set. Re-runs
// when the selector changes (`/plugin` toggles) or the registry mutates (another
// bundle registers its features after we mounted).
export function createFeatureSlots(
	selector: Accessor<PluginSelector>
): Accessor<Record<string, SlotEntry[]>> {
	const [slotMap, setSlotMap] = createSignal<Record<string, SlotEntry[]>>({})
	const cache = new Map<string, Record<string, SlotRenderer> | null>()
	let seq = 0

	const [registryTick, setRegistryTick] = createSignal(0)
	const off = onRegistryChange(FEATURE_TYPE, () => {
		// A newly-registered/loaded feature may expose slots we cached as null.
		cache.clear()
		setRegistryTick((n) => n + 1)
	})
	onCleanup(off)

	createEffect(() => {
		registryTick() // re-run when the registry changes
		const active = resolvePlugins(FEATURE_TYPE, featurePlugins, selector())
		const mySeq = ++seq
		Promise.all(
			active.map(async (p) => ({p, slots: await slotsForFeature(p, cache)}))
		).then((results) => {
			if (mySeq !== seq) return
			const map: Record<string, SlotEntry[]> = {}
			for (const {p, slots} of results) {
				if (!slots) continue
				for (const slot of Object.keys(slots)) {
					;(map[slot] ||= []).push({featureId: p.id, slot, render: slots[slot]})
				}
			}
			setSlotMap(map)
		})
	})

	return slotMap
}
