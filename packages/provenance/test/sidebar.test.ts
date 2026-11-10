import { beforeAll, describe, expect, it } from "vitest"
import { Repo, initSubduction, type DocHandle } from "@automerge/automerge-repo"
import { accept } from "@inkandswitch/patchwork-providers"
import { createNamer, packageName, plugins } from "../src/index.js"

let repo: Repo
beforeAll(async () => {
	await initSubduction()
	repo = new Repo({})
})

/** A package folder doc, the way pushwork writes one, and its root url with heads. */
function publish(pkg: Record<string, string>) {
	const file = repo.create({ content: JSON.stringify(pkg), mimeType: "application/json" })
	const folder = repo.create({
		"@patchwork": { type: "folder" },
		docs: [{ name: "package.json", type: "file", url: file.url }],
	})
	return `${folder.url}#${folder.heads().join("|")}`
}

describe("packageName", () => {
	it("is name@version from the package's package.json", async () => {
		expect(await packageName(repo, publish({ name: "@x/draw", version: "1.2.0" }))).toBe("@x/draw@1.2.0")
		expect(await packageName(repo, publish({ name: "@x/draw" }))).toBe("@x/draw")
	})

	it("is undefined for a package.json with no name, or a folder with none", async () => {
		expect(await packageName(repo, publish({ version: "1.0.0" }))).toBeUndefined()
		const empty = repo.create({ "@patchwork": { type: "folder" }, docs: [] })
		expect(await packageName(repo, empty.url)).toBeUndefined()
	})
})

describe("createNamer", () => {
	it("looks each url up once, and says when a name arrives", async () => {
		const url = publish({ name: "@x/draw", version: "1.2.0" })
		let arrived = 0
		const nameOf = createNamer(repo, () => arrived++)
		expect(nameOf(url)).toBeUndefined()
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(nameOf(url)).toBe("@x/draw@1.2.0")
		expect(arrived).toBe(1)
		nameOf(url)
		expect(arrived).toBe(1)
	})

	it("stays quiet when a lookup fails", async () => {
		const broken = { find: (): Promise<DocHandle<unknown>> => Promise.reject(new Error("unavailable")) }
		let arrived = 0
		const nameOf = createNamer(broken, () => arrived++)
		expect(nameOf("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ")).toBeUndefined()
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(nameOf("automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ")).toBeUndefined()
		expect(arrived).toBe(0)
	})
})

describe("plugins", () => {
	it("registers a context-tool component", () => {
		expect(plugins).toEqual([
			expect.objectContaining({ type: "patchwork:component", id: "provenance", tags: ["context-tool"], name: "Writers" }),
		])
	})
})

describe("the Writers component", () => {
	const KEY = "4kQx9TmB"
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
		expect(check()).toBe(true)
	}

	async function mount() {
		const frame = document.createElement("div")
		let select: ((urls: string[]) => void) | undefined
		frame.addEventListener("patchwork:subscribe", (event: any) => {
			if (event.detail.selector.type !== "patchwork:selected-doc") return
			accept<string[]>(event, respond => {
				select = respond
			})
		})
		const element = Object.assign(document.createElement("div"), { repo })
		frame.append(element)
		document.body.append(frame)
		const Writers = await plugins[0].load()
		const cleanup = Writers(element, repo)
		await until(() => select !== undefined)
		return { element, cleanup, select: (urls: string[]) => select!(urls) }
	}

	function stamped(url: string) {
		const root = publish({ name: "@x/draw", version: "1.2.0" })
		const handle: DocHandle<any> = repo.create<any>({ "@patchwork": { type: "test", writers: { [KEY]: { url: root } } } })
		handle.change(d => (d.n = 1), { message: `${url}\npw:${KEY}` })
		return handle
	}

	it("shows the selected doc's writers, by package name, and follows the selection", async () => {
		const { element, cleanup, select } = await mount()
		expect(element.textContent).toContain("Select a document to see who changed it.")
		const a = stamped("first doc")
		const b = stamped("second doc")
		select([`${a.url}#${a.heads().join("|")}`])
		await until(() => element.textContent!.includes("@x/draw@1.2.0"))
		expect(element.textContent).toContain("first doc")
		select([b.url])
		await until(() => element.textContent!.includes("second doc"))
		expect(element.textContent).not.toContain("first doc")
		select([])
		await until(() => element.textContent!.includes("Select a document to see who changed it."))
		cleanup()
		expect(element.childElementCount).toBe(0)
	})
})
