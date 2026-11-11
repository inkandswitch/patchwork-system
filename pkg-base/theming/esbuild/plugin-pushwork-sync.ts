import type {Plugin as EsbuildPlugin} from "esbuild"
import {execSync} from "node:child_process"
import {existsSync} from "node:fs"

export default function pushworkSync() {
	return {
		name: "pushwork",
		setup(build) {
			if (!existsSync(".pushwork")) {
				console.warn("no .pushwork directory! run `pushwork init .` first")
				return
			}

			build.onEnd((result) => {
				if (result.errors.length) {
					console.warn("esbuild errors! skipping pushwork sync")
					return
				}
				try {
					execSync("pushwork sync", {
						stdio: "inherit",
					})
				} catch (error) {
					console.warn((error as Error).message)
				}
			})
		},
	} satisfies EsbuildPlugin
}
