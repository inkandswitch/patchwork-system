import {beforeAll, describe, it, expect} from "vitest"
import {Repo, initSubduction, type AutomergeUrl} from "@automerge/automerge-repo"
import type {DecorationSet} from "@codemirror/view"
import {buildHighlights} from "./index"
import {createCommentForRange} from "./threads"

beforeAll(() => initSubduction())

const alice = "automerge:alice" as AutomergeUrl

const marks = (set: DecorationSet) => {
	const out: [number, number, string][] = []
	set.between(0, Infinity, (from, to, value) => {
		out.push([from, to, value.spec.class])
	})
	return out
}

describe("buildHighlights", () => {
	it("marks each commented range, emphasising the focused ones", async () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: "one two three"})
		createCommentForRange(handle, ["content"], 0, 3, alice)
		createCommentForRange(handle, ["content"], 8, 13, alice)
		const refs = handle.doc()["@comments"].threads.map((t: any) => t.refs[0])
		const [first, second] = await Promise.all(
			refs.map((url: AutomergeUrl) => repo.find(url)),
		)

		expect(marks(buildHighlights([first, second], [], 13))).toEqual([
			[0, 3, "cm-comment-target"],
			[8, 13, "cm-comment-target"],
		])

		expect(
			marks(buildHighlights([second, first], [second], 13)).map((m) => m[2]),
		).toEqual(["cm-comment-target", "cm-comment-target cm-comment-target-focused"])

		// clamped to what the editor is showing
		expect(marks(buildHighlights([second], [], 10))).toEqual([
			[8, 10, "cm-comment-target"],
		])
	})
})
