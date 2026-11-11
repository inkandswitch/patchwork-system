// runs tsgo's language server (typescript 7, compiled to wasm) against an
// in-memory filesystem. messages in and out are plain json-rpc strings

import { createMemFS } from "./memfs"

// requests the server makes of its client that only make sense to answer
// here, where the filesystem lives
const answers: Record<string, (params: any) => unknown> = {
	"client/registerCapability": () => null,
	"client/unregisterCapability": () => null,
	"window/workDoneProgress/create": () => null,
	"workspace/configuration": (params) => params.items.map(() => null),
	"workspace/diagnostic/refresh": () => null,
	"workspace/semanticTokens/refresh": () => null,
	"workspace/inlayHint/refresh": () => null,
	"workspace/codeLens/refresh": () => null,
}

export interface Tsgo {
	fs: ReturnType<typeof createMemFS>
	// a message from the client, forwarded to the server
	send(message: string): void
	// a notification of our own, for things the client doesn't know about
	notify(method: string, params: unknown): void
	// re-check every open file, e.g. after files they import have changed
	refresh(): void
	exited: Promise<void>
}

export async function startTsgo(
	wasm: BufferSource | Response | Promise<Response>,
	onMessage: (message: string) => void,
): Promise<Tsgo> {
	const memfs = createMemFS()
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()

	const g = globalThis as any
	g.fs = memfs.fs
	g.path = memfs.path
	g.process ??= memfs.process
	// wasm_exec looks for the globals above when it loads, so it has to wait
	// @ts-expect-error go's runtime: a script that sets globalThis.Go, not a module
	await import("./wasm_exec.js")

	function write(message: string) {
		const body = encoder.encode(message)
		memfs.writeStdin(
			encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`),
		)
		memfs.writeStdin(body)
	}

	// tsgo only answers diagnostic *requests* for source files, but most
	// clients wait for them to be pushed. so we ask on their behalf
	const open = new Set<string>()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	const ours = new Map<string, string>()
	let nextId = 0

	function check(uri: string) {
		clearTimeout(timers.get(uri))
		timers.set(
			uri,
			setTimeout(() => {
				timers.delete(uri)
				if (!open.has(uri)) return
				const id = `host:${nextId++}`
				ours.set(id, uri)
				write(JSON.stringify({
					jsonrpc: "2.0",
					id,
					method: "textDocument/diagnostic",
					params: { textDocument: { uri } },
				}))
			}, 200),
		)
	}

	// the server drops anything we say before the client has said hello
	let initialized = false
	let held: string[] = []

	function watch(message: string) {
		const value = JSON.parse(message)
		if (value.method == "initialized") {
			initialized = true
			for (const message of held) write(message)
			held = []
			for (const uri of open) check(uri)
		}
		const uri = value.params?.textDocument?.uri
		if (value.method == "textDocument/didOpen") open.add(uri)
		if (value.method == "textDocument/didClose") open.delete(uri)
		if (value.method == "textDocument/didOpen" || value.method == "textDocument/didChange") {
			check(uri)
		}
	}

	function receive(message: string) {
		const value = JSON.parse(message)
		if (typeof value.id == "string" && ours.has(value.id)) {
			const uri = ours.get(value.id)!
			ours.delete(value.id)
			if (value.result?.kind == "full" && open.has(uri)) {
				onMessage(JSON.stringify({
					jsonrpc: "2.0",
					method: "textDocument/publishDiagnostics",
					params: { uri, diagnostics: value.result.items },
				}))
			}
			return
		}
		if ("method" in value && "id" in value && value.method in answers) {
			write(JSON.stringify({
				jsonrpc: "2.0",
				id: value.id,
				result: answers[value.method](value.params),
			}))
			return
		}
		onMessage(message)
	}

	// stdout is a stream of `Content-Length: n\r\n\r\n` + n bytes of json
	let pending = new Uint8Array()
	memfs.onStdout((bytes) => {
		const joined = new Uint8Array(pending.byteLength + bytes.byteLength)
		joined.set(pending)
		joined.set(bytes, pending.byteLength)
		pending = joined
		while (true) {
			let end = -1
			for (let i = 0; i + 3 < pending.byteLength; i++) {
				if (
					pending[i] == 13 && pending[i + 1] == 10 &&
					pending[i + 2] == 13 && pending[i + 3] == 10
				) {
					end = i
					break
				}
			}
			if (end == -1) return
			const header = decoder.decode(pending.subarray(0, end))
			const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1])
			const start = end + 4
			if (pending.byteLength < start + length) return
			const message = decoder.decode(pending.subarray(start, start + length))
			pending = pending.slice(start + length)
			try {
				receive(message)
			} catch (error) {
				console.error("[tsgo] bad message", error, message)
			}
		}
	})

	const go = new g.Go()
	go.argv = ["tsgo", "--lsp", "--stdio"]
	go.env = { HOME: "/home", TMPDIR: "/tmp" }
	const imports = go.importObject
	const source = await wasm
	const { instance } = source instanceof Response
		? await WebAssembly.instantiateStreaming(source.clone(), imports)
			// streaming needs the right mime type, which not every server sends
			.catch(async () => WebAssembly.instantiate(await source.arrayBuffer(), imports))
		: await WebAssembly.instantiate(source, imports)
	const exited = go.run(instance) as Promise<void>

	return {
		fs: memfs,
		send(message) {
			write(message)
			watch(message)
		},
		notify(method, params) {
			const message = JSON.stringify({ jsonrpc: "2.0", method, params })
			if (initialized) write(message)
			else held.push(message)
		},
		refresh() {
			if (initialized) { for (const uri of open) check(uri) }
		},
		exited,
	}
}
