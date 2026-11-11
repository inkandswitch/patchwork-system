import {readFileSync, readdirSync} from "node:fs"
import {join} from "node:path"
import {pathToFileURL} from "node:url"
import {registerHooks} from "node:module"

const CONDITIONS = ["patchwork", "browser", "import"]

function resolveExport(value) {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined
  for (const condition of [...CONDITIONS, "default"]) {
    const resolved = condition in value ? resolveExport(value[condition]) : undefined
    if (resolved) return resolved
  }
}

function entryOf(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  return (pkg.exports && resolveExport(pkg.exports["."] ?? pkg.exports)) ?? pkg.main
}

const importedNames = new Map()

function recordImports(url, source) {
  const re = /(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"'./][^"']*)["']/g
  for (const [, clause, specifier] of source.matchAll(re)) {
    const key = `${url} ${specifier}`
    const names = importedNames.get(key) ?? new Set()
    for (const part of clause.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]
      if (name && name !== "default") names.add(name)
    }
    importedNames.set(key, names)
  }
}

const BROWSER_GLOBALS = [
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "CSSStyleSheet",
  "MutationObserver",
  "ResizeObserver",
  "localStorage",
  "location",
  "requestAnimationFrame",
]

const stub = new Proxy(function () {}, {
  get(_, key) {
    if (key === "then") return undefined
    if (key === Symbol.toPrimitive) return () => ""
    if (key === Symbol.iterator) return () => Array(8).fill(stub)[Symbol.iterator]()
    return stub
  },
  apply: () => stub,
  construct: () => stub,
})
globalThis[Symbol.for("modules-doc.stub")] = stub
for (const name of BROWSER_GLOBALS) globalThis[name] ??= stub

const STUB = `
const stub = globalThis[Symbol.for("modules-doc.stub")]
export default stub
`

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (err.code !== "ERR_MODULE_NOT_FOUND") throw err
      return {url: `stub:${encodeURIComponent(`${context.parentURL} ${specifier}`)}`, shortCircuit: true}
    }
  },
  load(url, context, next) {
    if (url.startsWith("stub:")) {
      const names = [...(importedNames.get(decodeURIComponent(url.slice(5))) ?? [])]
      const source = STUB + names.map((name) => `export const ${name} = stub\n`).join("")
      return {format: "module", source, shortCircuit: true}
    }
    const result = next(url, context)
    if (result.source) recordImports(url, String(result.source))
    return result
  },
})

process.on("unhandledRejection", () => {})
process.on("uncaughtException", () => {})

const packagesDir = process.argv[2]
const result = {}
for (const name of readdirSync(packagesDir).sort()) {
  try {
    const mod = await import(pathToFileURL(join(packagesDir, name, entryOf(join(packagesDir, name)))).href)
    result[name] = {plugins: (mod.plugins ?? []).map(({type, id}) => ({type, id}))}
  } catch (err) {
    result[name] = {error: String(err?.message ?? err)}
  }
}
process.send(result, () => process.exit(0))
