// TypeScript 7's language server (tsgo, compiled to wasm) in a worker, talking
// json-rpc with the editors' LSP client. Its files are in memory: the open
// editors' documents (as the client sends them) and one tsconfig for them all.
// The page's first message says where tsgo.wasm is; the rest are LSP.
import {startTsgo, type Tsgo} from "./tsgo/host"

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		target: "esnext",
		module: "esnext",
		moduleResolution: "bundler",
		allowJs: true,
		checkJs: false,
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		lib: ["esnext", "dom"],
		jsx: "preserve",
	},
	include: ["**/*"],
})

let tsgo: Tsgo | undefined
const queue: string[] = []

function start(wasm: string) {
	startTsgo(fetch(wasm), (lsp) => self.postMessage({lsp}))
		.then((ready) => {
			tsgo = ready
			ready.fs.writeFile("/tsconfig.json", TSCONFIG)
			for (const message of queue.splice(0)) ready.send(message)
		})
		.catch((error) => {
			console.error("[tsgo] failed to start", error)
			self.postMessage({failed: String(error?.message ?? error)})
		})
}

self.onmessage = (event: MessageEvent<{lsp: string} | {wasm: string}>) => {
	if ("wasm" in event.data) return start(event.data.wasm)
	if (tsgo) tsgo.send(event.data.lsp)
	else queue.push(event.data.lsp)
}
