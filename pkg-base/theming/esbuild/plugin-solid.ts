import * as babel from "@babel/core"
import {type Plugin as EsbuildPlugin} from "esbuild"
// @ts-expect-error no .d.ts
import babelSolid from "babel-preset-solid"
import {getJSXImportSource} from "./jsx-comments.ts"
import {readFile} from "node:fs/promises"

export function solid(): EsbuildPlugin {
	return {
		name: "solid",
		setup(build) {
			build.onLoad({filter: /\.(t|j)sx$/}, async (args) => {
				const isTypescript = args.path.endsWith(".tsx")
				const filename = args.path.replace(/.*\//, "")
				const content = await readFile(args.path, "utf-8")
				const contentJsxImportSource = getJSXImportSource(content)
				if (contentJsxImportSource == "solid-js" || !contentJsxImportSource) {
					let code = content
					if (isTypescript) {
						const trans = await build.esbuild.transform(content, {
							loader: "tsx" as const,
							jsx: "preserve",
						})
						code = trans.code
					}
					const result = await babel.transformAsync(code, {
						presets: [
							[babelSolid, {generate: "dom", hydratable: false}],
						],
						filename,
					})
					if (!result?.code) {
						console.warn(`failed to babel transform ${args.path}\n`)
						return null
					}
					return {contents: result.code, loader: "js"}
				}
				return null
			})
		},
	}
}
