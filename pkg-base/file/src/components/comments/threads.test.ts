import {beforeAll, describe, it, expect} from "vitest"
import {
	Repo,
	initSubduction,
	splice,
	type AutomergeUrl,
} from "@automerge/automerge-repo"
import {
	COMMENT_THREAD_TYPE,
	commentRanges,
	createCommentForRange,
	discardEmptyOwnDraft,
	findThreadByUrl,
	hasOwnDraft,
	type DocWithComments,
} from "./threads"

beforeAll(() => initSubduction())

const alice = "automerge:alice" as AutomergeUrl
const bob = "automerge:bob" as AutomergeUrl

const fileHandle = (content = "hello, world") => {
	const repo = new Repo()
	const handle = repo.create<DocWithComments & {content: string}>({
		content,
	} as any)
	return {repo, handle}
}

describe("createCommentForRange", () => {
	it("adds a thread with a cursor ref to the range and an empty comment", () => {
		const {handle} = fileHandle()
		const threadUrl = createCommentForRange(handle, ["content"], 0, 5, alice)

		const threads = handle.doc()["@comments"]!.threads
		expect(threads).toHaveLength(1)
		const [thread] = threads
		expect(thread.isResolved).toBe(false)
		expect(thread["@patchwork"]).toEqual({type: COMMENT_THREAD_TYPE})
		expect(thread.comments).toHaveLength(1)
		expect(thread.comments[0].contactUrl).toBe(alice)
		expect(thread.comments[0].content).toBeUndefined()
		expect(thread.refs).toHaveLength(1)
		expect(thread.refs[0].startsWith(handle.url)).toBe(true)

		expect(findThreadByUrl(handle, threadUrl)?.id).toBe(thread.id)
	})

	it("refuses to make a range on content that isn't text", () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: new Uint8Array([1, 2, 3])})
		expect(() =>
			createCommentForRange(handle, ["content"], 0, 1, alice),
		).toThrow()
		expect(handle.doc()["@comments"]).toBeUndefined()
	})
})

describe("commentRanges", () => {
	it("follows the text as it's edited and skips collapsed ranges", async () => {
		const {repo, handle} = fileHandle("hello, world")
		createCommentForRange(handle, ["content"], 7, 12, alice)
		const [ref] = handle.doc()["@comments"]!.threads[0].refs
		const target = await repo.find(ref)

		expect(commentRanges([target])).toEqual([[7, 12]])

		handle.change((doc: any) => splice(doc, ["content"], 0, 0, "oh "))
		expect(commentRanges([target])).toEqual([[10, 15]])

		handle.change((doc: any) => splice(doc, ["content"], 10, 5, ""))
		expect(commentRanges([target])).toEqual([])
	})
})

describe("drafts", () => {
	it("knows whether a thread still has the author's unsent comment", () => {
		const {handle} = fileHandle()
		const url = createCommentForRange(handle, ["content"], 0, 5, alice)
		const thread = () => findThreadByUrl(handle, url)!

		expect(hasOwnDraft(thread(), alice)).toBe(true)
		expect(hasOwnDraft(thread(), bob)).toBe(false)

		handle.change((doc) => {
			doc["@comments"]!.threads[0].comments[0].content = "nice"
		})
		expect(hasOwnDraft(thread(), alice)).toBe(false)
	})

	it("drops an abandoned thread that only held the author's empty draft", () => {
		const {handle} = fileHandle()
		const url = createCommentForRange(handle, ["content"], 0, 5, alice)

		discardEmptyOwnDraft(handle, url, alice)

		expect(handle.doc()["@comments"]!.threads).toHaveLength(0)
	})

	it("keeps a thread that has someone's real comment in it", () => {
		const {handle} = fileHandle()
		const url = createCommentForRange(handle, ["content"], 0, 5, bob)
		handle.change((doc) => {
			const thread = doc["@comments"]!.threads[0]
			thread.comments[0].content = "first"
			thread.comments.push({
				id: "reply",
				contactUrl: alice,
				timestamp: 0,
				draftContent: "  ",
			})
		})

		discardEmptyOwnDraft(handle, url, alice)

		const [thread] = handle.doc()["@comments"]!.threads
		expect(thread.comments).toHaveLength(1)
		expect(thread.comments[0].content).toBe("first")
	})

	it("leaves a draft that has text in it", () => {
		const {handle} = fileHandle()
		const url = createCommentForRange(handle, ["content"], 0, 5, alice)
		handle.change((doc) => {
			doc["@comments"]!.threads[0].comments[0].draftContent = "wip"
		})

		discardEmptyOwnDraft(handle, url, alice)

		expect(handle.doc()["@comments"]!.threads).toHaveLength(1)
	})
})
