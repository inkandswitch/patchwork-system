import {describe, it, expect} from "vitest"
import {isBinaryCheck} from "./isBinaryFile"

const bytes = (s: string) => new TextEncoder().encode(s)

describe("isBinaryCheck", () => {
	it("treats an empty read as not binary", () => {
		expect(isBinaryCheck(new Uint8Array(), 0)).toBe(false)
	})

	it("treats plain ASCII text as not binary", () => {
		const buf = bytes("hello, world\nthis is text\t!")
		expect(isBinaryCheck(buf, buf.length)).toBe(false)
	})

	it("treats a NULL byte as binary", () => {
		const buf = new Uint8Array([104, 105, 0, 104, 105])
		expect(isBinaryCheck(buf, buf.length)).toBe(true)
	})

	it("recognizes a PDF header as binary", () => {
		const buf = bytes("%PDF-1.7 and then some more content here")
		expect(isBinaryCheck(buf, buf.length)).toBe(true)
	})

	it("treats a UTF-8 BOM prefix as not binary", () => {
		const buf = new Uint8Array([0xef, 0xbb, 0xbf, 104, 105])
		expect(isBinaryCheck(buf, buf.length)).toBe(false)
	})

	it("flags content with many suspicious control bytes as binary", () => {
		// >10% high/control bytes across >32 bytes
		const buf = new Uint8Array(64)
		for (let i = 0; i < buf.length; i++) {
			buf[i] = i % 2 === 0 ? 0x41 : 0x01 // 'A' alternating with a control byte
		}
		expect(isBinaryCheck(buf, buf.length)).toBe(true)
	})
})
