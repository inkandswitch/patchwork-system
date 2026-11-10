import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { Repo, initSubduction, type DocHandle } from "@automerge/automerge-repo"
import { renderWriters, writerLabel, type WritersCleanup } from "../src/index.js"

const KEY_A = "4kQx9TmB"
const ROOT_A = "automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ#abc"
let repo: Repo
beforeAll(async () => {
	await initSubduction()
	repo = new Repo({})
})
const frame = () => new Promise(resolve => setTimeout(resolve, 50))

let cleanup: WritersCleanup | undefined
afterEach(() => {
	cleanup?.()
	cleanup = undefined
})

function setup(names: Record<string, string> = {}) {
	const handle: DocHandle<any> = repo.create<any>({ "@patchwork": { type: "test", writers: { [KEY_A]: { url: ROOT_A } } }, n: 0 })
	handle.change(d => (d.n = 1), { message: `rename layer\npw:${KEY_A}` })
	const container = document.createElement("div")
	cleanup = renderWriters(container, handle, { nameOf: (url: string) => names[url] })
	return { handle, container }
}

describe("writerLabel", () => {
	it("names each kind of writer", () => {
		const nameOf = (url: string) => (url === ROOT_A ? "@x/draw@1.2.0" : undefined)
		expect(writerLabel({ url: ROOT_A }, KEY_A, nameOf)).toBe("@x/draw@1.2.0")
		expect(writerLabel({ url: ROOT_A }, KEY_A, () => undefined)).toBe("automerge:2j9knp…")
		expect(writerLabel({ url: "site@42" }, KEY_A, nameOf)).toBe("site (build 42)")
		expect(writerLabel({ url: "http://localhost:5173/src/main.tsx" }, KEY_A, nameOf)).toBe(
			"http://localhost:5173/src/main.tsx",
		)
		expect(writerLabel("unrecorded", KEY_A, nameOf)).toBe(`pw:${KEY_A} (no record)`)
		expect(writerLabel(null, null, nameOf)).toBe("Unstamped")
	})
})

describe("renderWriters", () => {
	it("shows each writer with its count, and the recent changes", () => {
		const { container } = setup({ [ROOT_A]: "@x/draw@1.2.0" })
		const writers = [...container.querySelectorAll(".pw-writers__writer")].map(li => li.textContent!)
		expect(writers).toHaveLength(2)
		const draw = writers.find(text => text.includes("@x/draw@1.2.0"))
		expect(draw).toContain("1 change")
		expect(writers.find(text => text.includes("Unstamped"))).toBeDefined()
		const changes = [...container.querySelectorAll(".pw-writers__change")].map(li => li.textContent!)
		expect(changes[0]).toContain("rename layer")
		expect(changes[0]).toContain("@x/draw@1.2.0")
		expect(changes.at(-1)).toContain("Unstamped")
	})

	it("puts the writer's url in the title", () => {
		const { container } = setup()
		const titles = [...container.querySelectorAll(".pw-writers__writer")].map(li => (li as HTMLElement).title)
		expect(titles).toContain(ROOT_A)
	})

	it("renders a message as text", () => {
		const { handle, container } = setup()
		handle.change(d => (d.n = 2), { message: `<img src=x onerror=alert(1)>\npw:${KEY_A}` })
		return frame().then(() => {
			expect(container.querySelector("img")).toBeNull()
			expect(container.textContent).toContain("<img src=x onerror=alert(1)>")
		})
	})

	it("follows the doc as it changes", async () => {
		const { handle, container } = setup()
		handle.change(d => (d.n = 2), { message: `again\npw:${KEY_A}` })
		await frame()
		expect(container.querySelector(".pw-writers__change")!.textContent).toContain("again")
		expect(container.querySelector(".pw-writers__writer")!.textContent).toContain("2 changes")
	})

	it("stops following and empties on cleanup", async () => {
		const { handle, container } = setup()
		cleanup!()
		cleanup = undefined
		expect(container.childElementCount).toBe(0)
		handle.change(d => (d.n = 2), { message: `again\npw:${KEY_A}` })
		await frame()
		expect(container.childElementCount).toBe(0)
	})
})
