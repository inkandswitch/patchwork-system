import {defineConfig} from "vite"
import solidPlugin from "vite-plugin-solid"
import patchworkBundles from "@chee/patchwork-bundles/vite"
import external from "@inkandswitch/patchwork-bootloader/externals"

export default defineConfig({
	base: "./",
	// Rewrite the automerge:-versioned @chee/patchwork-llm dep to a shared
	// service-worker URL resolved at runtime (cross-origin), so the LLM lib loads
	// as one canonical copy. This tool runs HOST-only, so loading patchwork-llm
	// here is fine. (The tray injects its own <style>, so no CSS plugin needed.)
	plugins: [
		solidPlugin(),
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
