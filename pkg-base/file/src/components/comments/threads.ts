// Comment threads stored on the file doc itself, under `@comments.threads`,
// in the shape the comments provider and the Comments sidebar
// (comments-view) read from any doc. Adapted from codemirror-base's
// lib/extensions/comments.ts and the thread bookkeeping in its tool.tsx.

import {
	cursor,
	type AutomergeUrl,
	type DocHandle,
} from "@automerge/automerge-repo/slim"

export type DocWithComments = {
	"@comments"?: {
		threads: CommentThread[]
	}
}

// The `@patchwork.type` stamped on a thread so it resolves to the
// `comment-thread` tool when it's opened on its own (e.g. in the popover).
export const COMMENT_THREAD_TYPE = "comment-thread"

export type CommentThread = {
	id: string
	refs: AutomergeUrl[]
	isResolved: boolean
	comments: Comment[]
	"@patchwork"?: {type: string; title?: string}
}

export type Comment = {
	id: string
	content?: string
	draftContent?: string
	contactUrl: AutomergeUrl
	timestamp: number
}

// Start a thread on [from, to] of the text at `path`, holding one empty
// comment for the author to fill in, and return the thread's url. The range
// is a pair of automerge cursors, so it follows the text as it's edited. That
// only works on real text: on anything else (an ImmutableString, bytes) this
// throws without touching the doc.
export function createCommentForRange(
	handle: DocHandle<any>,
	path: readonly string[],
	from: number,
	to: number,
	contactUrl: AutomergeUrl,
): AutomergeUrl {
	const targetUrl = handle.sub(...path, cursor(from, to)).url
	const threadId = crypto.randomUUID()

	handle.change((doc: DocWithComments) => {
		doc["@comments"] ??= {threads: []}
		doc["@comments"].threads.push({
			id: threadId,
			refs: [targetUrl],
			isResolved: false,
			comments: [
				{id: crypto.randomUUID(), contactUrl, timestamp: Date.now()},
			],
			"@patchwork": {type: COMMENT_THREAD_TYPE},
		})
	})

	return threadUrl(handle, threadId)
}

const threadUrl = (handle: DocHandle<any>, id: string): AutomergeUrl =>
	handle.sub("@comments", "threads", {id}).url

export function findThreadByUrl(
	handle: DocHandle<any>,
	url: AutomergeUrl,
): CommentThread | undefined {
	const threads: CommentThread[] =
		(handle.doc() as DocWithComments | undefined)?.["@comments"]?.threads ?? []
	return threads.find((thread) => threadUrl(handle, thread.id) === url)
}

// Whether the author still has an unsent comment in the thread: one never
// filled in, or one with a draft in progress.
export const hasOwnDraft = (
	thread: CommentThread,
	contactUrl: AutomergeUrl | undefined,
): boolean =>
	thread.comments.some(
		(c) =>
			c.contactUrl === contactUrl &&
			(c.draftContent !== undefined || c.content === undefined),
	)

const isEmptyOwnDraft = (c: Comment, contactUrl: AutomergeUrl | undefined) =>
	c.contactUrl === contactUrl &&
	c.content === undefined &&
	(c.draftContent === undefined || c.draftContent.trim() === "")

// Throw away the author's comments in a thread that were never written, and
// the thread itself if that empties it. So opening the comment popover and
// walking away doesn't leave an empty thread behind.
export function discardEmptyOwnDraft(
	handle: DocHandle<any>,
	url: AutomergeUrl,
	contactUrl: AutomergeUrl | undefined,
): void {
	const thread = findThreadByUrl(handle, url)
	if (!thread?.comments.some((c) => isEmptyOwnDraft(c, contactUrl))) return
	const threadId = thread.id
	handle.change((doc: DocWithComments) => {
		const list = doc["@comments"]?.threads
		const index = list?.findIndex((t) => t.id === threadId) ?? -1
		if (!list || index === -1) return
		const comments = list[index].comments
		for (let i = comments.length - 1; i >= 0; i--) {
			if (isEmptyOwnDraft(comments[i], contactUrl)) comments.splice(i, 1)
		}
		if (comments.length === 0) list.splice(index, 1)
	})
}

// Where each target range sits in the text right now, leaving out any whose
// text has been deleted out from under it.
export const commentRanges = (
	targets: DocHandle<unknown>[],
): [number, number][] => {
	const ranges: [number, number][] = []
	for (const target of targets) {
		const positions = target.rangePositions()
		if (!positions || positions[0] === positions[1]) continue
		ranges.push(positions)
	}
	return ranges
}
