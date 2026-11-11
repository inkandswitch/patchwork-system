import {defineConfig} from "vite"
import solidPlugin from "vite-plugin-solid"
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js"
import patchworkBundles from "@chee/patchwork-bundles/vite"
import external from "@inkandswitch/patchwork-bootloader/externals"

export default defineConfig({
	base: "./",
	// patchworkBundles() rewrites `automerge:`-versioned deps (e.g.
	// @chee/patchwork-llm) to a shared service-worker URL marked external, so the
	// lib + its SharedWorker are loaded as ONE canonical copy shared across every
	// tool — not bundled per-tool. (Matches llm/src/chat.)
	//
	// "patchwork:cross-origin": resolve those service-worker URLs at *runtime*
	// (against the running document's origin) instead of baking a root-relative
	// `/automerge:…` import. That root-relative form resolves against the tool's
	// own serving origin — fine when served same-origin as the service worker,
	// but a 404 now that the tools bundle is hosted on a separate origin
	// (netlify). The runtime form uses a top-level-await dynamic import, so the
	// build target must support TLA (see build.target below).
	plugins: [
		solidPlugin(),
		cssInjectedByJsPlugin(),
		patchworkBundles({rewrite: {automerge: "patchwork:cross-origin"}}),
	],
	build: {
		// top-level await in the cross-origin virtual modules
		target: "esnext",
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: "index",
		},
		rollupOptions: {external},
	},
})
