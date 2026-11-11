import {describe, it, expect} from "vitest"
import {getMimeType} from "./mime-types"

describe("getMimeType", () => {
	it("maps known extensions with a leading dot", () => {
		expect(getMimeType(".json")).toBe("application/json")
		expect(getMimeType(".png")).toBe("image/png")
		expect(getMimeType(".pdf")).toBe("application/pdf")
	})

	it("accepts extensions without a leading dot", () => {
		expect(getMimeType("ts")).toBe("text/typescript")
		expect(getMimeType("svg")).toBe("image/svg+xml")
	})

	it("falls back to text/plain for unknown extensions", () => {
		expect(getMimeType(".nope")).toBe("text/plain")
		expect(getMimeType("")).toBe("text/plain")
	})
})
