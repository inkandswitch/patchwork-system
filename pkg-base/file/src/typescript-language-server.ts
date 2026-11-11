// One TypeScript language server (tsgo, in a worker) shared by every JS/TS
// editor on the page, started the first time a code file is opened. Its wasm
// is ~49MB, so the first answers can take a while; the client waits.
import {
	LSPClient,
	languageServerExtensions,
	type Transport,
} from "@codemirror/lsp-client"

let client: LSPClient | undefined

// tsgo.wasm is written out next to this module by the build (vite.config.ts).
// it's named through a variable so vite doesn't try to bundle it (it rewrites
// new URL() with a literal or template literal)
const WASM = "tsgo.wasm"

export function typescriptLanguageServer(): LSPClient {
	if (client) return client
	const worker = new Worker(new URL("./tsgo-worker.ts", import.meta.url), {
		type: "module",
	})
	worker.postMessage({wasm: new URL(WASM, import.meta.url).href})
	const handlers = new Set<(message: string) => void>()
	worker.onmessage = (event) => {
		if (typeof event.data?.lsp === "string") {
			for (const handler of handlers) handler(event.data.lsp)
		} else if (event.data?.failed) {
			// type hints are an extra: without them it's a plain editor
			console.error("TypeScript language server didn't start:", event.data.failed)
		}
	}
	worker.onerror = (event) => {
		console.error("TypeScript language server worker:", event.message)
	}
	const transport: Transport = {
		send: (message) => worker.postMessage({lsp: message}),
		subscribe: (handler) => handlers.add(handler),
		unsubscribe: (handler) => handlers.delete(handler),
	}
	client = new LSPClient({
		rootUri: "file:///",
		timeout: 30_000,
		extensions: languageServerExtensions(),
	}).connect(transport)
	return client
}
