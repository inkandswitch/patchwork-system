import {describe, it, expect} from "vitest"
import {getLanguageExtension} from "./languages"

// CodeMirror language support resolves to a non-empty Extension (array). An
// unrecognized input resolves to an empty array, which is how this module
// signals "no language".
const isEmpty = (ext: unknown) => Array.isArray(ext) && ext.length === 0

describe("getLanguageExtension", () => {
	it("resolves a known extension (with or without a leading dot)", () => {
		expect(isEmpty(getLanguageExtension(".ts"))).toBe(false)
		expect(isEmpty(getLanguageExtension("json"))).toBe(false)
	})

	it("resolves a known mime type when no extension matches", () => {
		expect(isEmpty(getLanguageExtension(undefined, "text/markdown"))).toBe(false)
	})

	it("returns an empty extension for unknown inputs", () => {
		expect(isEmpty(getLanguageExtension(".unknown"))).toBe(true)
		expect(isEmpty(getLanguageExtension(undefined, "application/x-nope"))).toBe(
			true
		)
		expect(isEmpty(getLanguageExtension())).toBe(true)
	})
})
