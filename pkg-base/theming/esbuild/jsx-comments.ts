import {parse} from "@babel/parser"

export function getJSXImportSource(source: string): string | undefined {
	const settings = getJSXSettings(source)
	if (!settings) return
	if (settings.runtime && settings.runtime != "automatic") return
	return settings.importsource
}

export function getJSXSettings(
	source: string
): Record<string, string> | undefined {
	const jsxComments = getJSXComments(source)
	const values = jsxComments
		?.flatMap((c) => {
			return c.value
				.split("\n")
				.map((v) => v.match(/@jsx(\S+)\s+(\S+)/i)?.slice(1)) as [
				string,
				string,
			][]
		})
		.filter(Boolean)
	return (
		values && Object.fromEntries(values.map((v) => [v[0].toLowerCase(), v[1]]))
	)
}

export function getJSXComments(source: string) {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "jsx"],
		ranges: true,
	})
	const body = ast.program.body
	if (body.length === 0) return null
	if (!ast.comments) return null
	const firstCode = body[0].start ?? Infinity
	const matches = ast.comments.filter((c) => {
		return (
			c.type === "CommentBlock" &&
			c.end! <= firstCode! &&
			/@jsx\S+\s+\S+/i.test(c.value)
		)
	})
	return matches
}
