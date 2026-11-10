import { describe, expect, it } from "vitest"
import * as A from "@automerge/automerge/slim"
import { createHistory, parseMessage } from "../src/index.js"

const KEY_A = "4kQx9TmB"
const KEY_B = "7wZp2RnC"
const ROOT_A = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ#abc"

/** A doc whose first change records KEY_A, then the changes `steps` describe. */
function make(steps: (string | undefined)[], writers: unknown = { [KEY_A]: { url: ROOT_A } }) {
	let doc = A.from<any>({ "@patchwork": { type: "test", writers }, n: 0 })
	for (const message of steps) {
		doc = A.change(doc, message === undefined ? {} : { message }, d => {
			d.n++
		})
	}
	return doc
}

describe("parseMessage", () => {
	it("splits the caller's message from the key line", () => {
		expect(parseMessage(null)).toEqual({ message: null, key: null })
		expect(parseMessage("rename layer")).toEqual({ message: "rename layer", key: null })
		expect(parseMessage(`pw:${KEY_A}`)).toEqual({ message: null, key: KEY_A })
		expect(parseMessage(`rename layer\npw:${KEY_A}`)).toEqual({ message: "rename layer", key: KEY_A })
	})

	it("leaves a pw: line that isn't a key, or isn't last, in the message", () => {
		expect(parseMessage("pw:short")).toEqual({ message: "pw:short", key: null })
		expect(parseMessage(`pw:${KEY_A}\nmore`)).toEqual({ message: `pw:${KEY_A}\nmore`, key: null })
	})
})

describe("createHistory", () => {
	it("lists changes newest first, each with its writer", () => {
		const doc = make([`pw:${KEY_A}`, `fix\npw:${KEY_A}`])
		const history = createHistory()
		history.update(doc)
		const recent = history.recent(doc)
		expect(recent.map(r => r.message)).toEqual(["fix", null, null])
		expect(recent[0]).toMatchObject({ key: KEY_A, writer: { url: ROOT_A } })
		expect(recent.at(-1)).toMatchObject({ key: null, writer: null })
	})

	it("groups by writer, most changes first", () => {
		const doc = make([`pw:${KEY_A}`, `pw:${KEY_A}`, `pw:${KEY_B}`])
		const history = createHistory()
		history.update(doc)
		expect(history.summary(doc).map(g => [g.key, g.count, g.writer])).toEqual([
			[KEY_A, 2, { url: ROOT_A }],
			[null, 1, null],
			[KEY_B, 1, "unrecorded"],
		])
	})

	it("reads only the new changes on a later update", () => {
		let doc = make([`pw:${KEY_A}`])
		const history = createHistory()
		expect(history.update(doc)).toBe(2)
		expect(history.update(doc)).toBe(0)
		doc = A.change(doc, { message: `pw:${KEY_B}` }, d => {
			d.n++
		})
		expect(history.update(doc)).toBe(1)
		expect(history.recent(doc)[0].key).toBe(KEY_B)
		expect(history.summary(doc).find(g => g.key === KEY_A)!.count).toBe(1)
	})

	it("keeps only the newest `limit` changes, but counts them all", () => {
		const doc = make(Array.from({ length: 10 }, () => `pw:${KEY_A}`))
		const history = createHistory({ limit: 3 })
		history.update(doc)
		expect(history.recent(doc)).toHaveLength(3)
		expect(history.summary(doc).find(g => g.key === KEY_A)!.count).toBe(10)
	})

	it("resolves a key against the record as it is now", () => {
		let doc = make([`pw:${KEY_B}`])
		const history = createHistory()
		history.update(doc)
		expect(history.recent(doc)[0].writer).toBe("unrecorded")
		doc = A.change(doc, d => {
			d["@patchwork"].writers[KEY_B] = { url: "site@42" }
		})
		expect(history.recent(doc).find(r => r.key === KEY_B)!.writer).toEqual({ url: "site@42" })
	})

	it("copes with no record, or one that isn't an object", () => {
		const doc = make([`pw:${KEY_A}`], "x")
		const history = createHistory()
		history.update(doc)
		expect(history.recent(doc)[0].writer).toBe("unrecorded")
		const bare = A.change(A.from<any>({ n: 0 }), { message: `pw:${KEY_A}` }, d => {
			d.n++
		})
		const fresh = createHistory()
		fresh.update(bare)
		expect(fresh.recent(bare)[0].writer).toBe("unrecorded")
	})
})
