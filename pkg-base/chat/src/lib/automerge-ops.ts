// Universal Automerge op applier — ported from newspace/src/opstreams.js
// (`applyAutomerge` + its COW helpers). One vocabulary covers every edit to any
// part of an Automerge document:
//
//   path   string|number[]   keys/indices from the doc root to the container/value
//                             you're touching ([] = the root).
//   range  [from,to] | key    SPLICE mode when an array → replace elements from..to
//                             (text chars on a string field, items on a list).
//                             ASSIGN/DELETE mode when a key (string|number) → set or
//                             (with no value) delete that key on the map/list at path.
//   value  any                what to insert/set. Omit / null / undefined to delete.
//
// `applyAutomerge(draft, path, range, value)` MUST run inside a `handle.change()`
// (or `handle.changeAt()` for a back-dated edit) — `draft` is the mutable proxy.

import {splice as amSplice} from "@automerge/automerge/slim"

type Path = (string | number)[]

function nodeAt(root: any, path: Path): any {
	let n = root
	for (const k of path) n = n == null ? n : n[k]
	return n
}

function setKey(container: any, key: any, value: any): any {
	if (Array.isArray(container)) {
		const c = container.slice()
		c[key] = value
		return c
	}
	return {...(container || {}), [key]: value}
}

// COW patch of an in-memory value — only used to rebuild bytes / scalars before
// re-assigning them onto the draft (automerge has no in-place splice for those).
function patchHere(container: any, range: any, value: any): any {
	if (Array.isArray(range)) {
		const [from = 0, to = from] = range
		if (
			typeof container === "string" ||
			(container == null && typeof value === "string")
		) {
			const base = typeof container === "string" ? container : ""
			return base.slice(0, from) + (value == null ? "" : value) + base.slice(to)
		}
		if (container instanceof Uint8Array) {
			const insert = value == null ? [] : Array.from(value as any)
			const out = [
				...container.slice(0, from),
				...insert,
				...container.slice(to),
			]
			return Uint8Array.from(out as any)
		}
		const copy = (container || []).slice()
		copy.splice(from, to - from, ...(value == null ? [] : ([] as any).concat(value)))
		return copy
	}
	if (value === undefined) {
		if (Array.isArray(container)) {
			const c = container.slice()
			c.splice(range, 1)
			return c
		}
		const c = {...container}
		delete c[range]
		return c
	}
	return setKey(container, range, value)
}

function apply(value: any, op: {path?: Path; range: any; value?: any}): any {
	const path = op.path || []
	if (path.length === 0) return patchHere(value, op.range, op.value)
	const [head, ...rest] = path
	const child = patchPath(value?.[head], rest, op)
	return setKey(value, head, child)
}

function patchPath(node: any, path: Path, op: {range: any; value?: any}): any {
	if (path.length === 0) return patchHere(node, op.range, op.value)
	const [head, ...rest] = path
	return setKey(node, head, patchPath(node?.[head], rest, op))
}

// Replace the value at `path` (used for the bytes/scalar rebuild path).
function replaceAt(draft: any, path: Path, value: any): void {
	if (path.length === 0) {
		for (const k of Object.keys(draft)) delete draft[k]
		Object.assign(draft, value)
		return
	}
	const target = nodeAt(draft, path)
	if (typeof target === "string") {
		amSplice(draft, path as any, 0, target.length, value)
		return
	}
	const parent = nodeAt(draft, path.slice(0, -1))
	parent[path[path.length - 1]] = value
}

/** Apply a universal op to an automerge draft at an absolute `path`. */
export function applyAutomerge(
	draft: any,
	path: Path,
	range: any,
	value: any
): void {
	if (Array.isArray(range)) {
		const [from = 0, to = from] = range
		const target = nodeAt(draft, path)
		if (typeof target === "string") {
			amSplice(draft, path as any, from, to - from, value == null ? "" : value)
		} else if (Array.isArray(target)) {
			// LIST splice — use the proxy's splice so OBJECT elements materialise
			// (automerge's splice() helper is for text/scalars only).
			target.splice(from, to - from, ...(value == null ? [] : ([] as any).concat(value)))
		} else {
			// bytes / scalar: COW-rebuild the whole value and re-assign it.
			replaceAt(draft, path, apply(target, {path: [], range, value}))
		}
		return
	}
	// assign / delete at key `range`
	const container = nodeAt(draft, path)
	if (value === undefined) {
		if (Array.isArray(container)) container.splice(range, 1)
		else delete container[range]
	} else {
		container[range] = value
	}
}
