import {describe, it, expect, vi} from "vitest"
import {
	isImageFile,
	isVideoFile,
	compareBuffers,
	createBinaryUrl,
} from "./utils"

describe("isImageFile", () => {
	it("recognizes image extensions case-insensitively", () => {
		expect(isImageFile({extension: "png"})).toBe(true)
		expect(isImageFile({extension: "JPG"})).toBe(true)
		expect(isImageFile({extension: "svg"})).toBe(true)
	})

	it("rejects non-image and missing extensions", () => {
		expect(isImageFile({extension: "mp4"})).toBe(false)
		expect(isImageFile({extension: ""})).toBe(false)
		expect(isImageFile({extension: undefined as unknown as string})).toBe(false)
	})
})

describe("isVideoFile", () => {
	it("recognizes video extensions case-insensitively", () => {
		expect(isVideoFile({extension: "mp4"})).toBe(true)
		expect(isVideoFile({extension: "WEBM"})).toBe(true)
	})

	it("rejects non-video extensions", () => {
		expect(isVideoFile({extension: "png"})).toBe(false)
	})
})

describe("compareBuffers", () => {
	it("returns true for identical Uint8Arrays", () => {
		const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
		const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(compareBuffers(a, b)).toBe(true)
	})

	it("returns false when lengths differ", () => {
		expect(compareBuffers(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(
			false
		)
	})

	it("detects a difference in the 64-bit-chunked region", () => {
		const a = new Uint8Array(16).fill(1)
		const b = new Uint8Array(16).fill(1)
		b[3] = 9
		expect(compareBuffers(a, b)).toBe(false)
	})

	it("detects a difference in the trailing remainder bytes", () => {
		// 10 bytes => one 8-byte chunk + 2 remainder bytes
		const a = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 2])
		const b = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 3])
		expect(compareBuffers(a, b)).toBe(false)
	})

	it("accepts ArrayBuffer inputs", () => {
		const a = new Uint8Array([5, 6, 7]).buffer
		const b = new Uint8Array([5, 6, 7]).buffer
		expect(compareBuffers(a, b)).toBe(true)
	})
})

describe("createBinaryUrl", () => {
	it("returns undefined for non-Uint8Array values", () => {
		expect(createBinaryUrl(undefined)).toBeUndefined()
		expect(createBinaryUrl("nope" as unknown as Uint8Array)).toBeUndefined()
	})

	it("returns an object URL for a Uint8Array", () => {
		const url = createBinaryUrl(new Uint8Array([1, 2, 3]))
		expect(typeof url).toBe("string")
		expect(url).toMatch(/^blob:/)
	})

	// An object URL serves the blob's type as its Content-Type. Without one an
	// <iframe> renders a PDF as source text instead of opening the viewer.
	it("tags the blob with the given mime type", () => {
		const spy = vi.spyOn(URL, "createObjectURL")
		createBinaryUrl(new Uint8Array([1, 2, 3]), "application/pdf")
		expect(spy.mock.calls[0][0]).toBeInstanceOf(Blob)
		expect((spy.mock.calls[0][0] as Blob).type).toBe("application/pdf")
		spy.mockRestore()
	})

	it("leaves the blob untyped when no mime type is given", () => {
		const spy = vi.spyOn(URL, "createObjectURL")
		createBinaryUrl(new Uint8Array([1, 2, 3]))
		expect((spy.mock.calls[0][0] as Blob).type).toBe("")
		spy.mockRestore()
	})
})
