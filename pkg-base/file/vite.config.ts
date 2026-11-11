import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {defineConfig, type Plugin} from "vite"
import solidPlugin from "vite-plugin-solid"
import external from "@inkandswitch/patchwork-bootloader/externals"

const require = createRequire(import.meta.url)

// TypeScript's language server (tsgo) is ~49MB of wasm. A library build would
// inline it into the worker as base64, so it goes out as its own file next to
// the code instead, and the page tells the worker where it is
// (typescript-language-server.ts)
function tsgoWasm(): Plugin {
	return {
		name: "tsgo-wasm",
		apply: "build",
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: "tsgo.wasm",
				source: readFileSync(require.resolve("tsgo-wasm")),
			})
		},
	}
}

export default defineConfig({
	// relative, so the worker is found next to the code wherever it's served
	base: "./",
	plugins: [solidPlugin(), tsgoWasm()],
	// the TypeScript language server's worker loads its wasm runtime with a
	// dynamic import, which needs a module worker
	worker: {format: "es"},
	build: {
		sourcemap: true,
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {external},
	},
})
