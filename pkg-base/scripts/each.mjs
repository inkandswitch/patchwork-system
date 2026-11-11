#!/usr/bin/env node
// Run a pnpm script in every tool that has one.
//
// There is no workspace here, so `pnpm -r` has nothing to recurse over. This
// walks the top-level folders instead, runs `pnpm <script>` in each one that
// declares it, buffers the output so concurrent logs stay readable, and exits
// non-zero if any of them failed. `install` runs everywhere, script or not.
//
//   node scripts/each.mjs install
//   node scripts/each.mjs test
//   node scripts/each.mjs build --filter tldraw

import {existsSync, readFileSync, readdirSync, statSync} from "node:fs"
import {spawn} from "node:child_process"
import {availableParallelism} from "node:os"
import {join, dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const [script, ...rest] = process.argv.slice(2)
if (!script) {
  console.error("usage: node scripts/each.mjs <script> [--filter <name>]...")
  process.exit(1)
}

const filters = rest.flatMap((arg, i) => (rest[i - 1] === "--filter" ? [arg] : []))

const CONCURRENCY = Math.max(
  1,
  Number(process.env.EACH_CONCURRENCY) || availableParallelism() - 1
)

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  } catch {
    return null
  }
}

const tools = readdirSync(ROOT)
  .sort()
  .filter((name) => {
    if (name.startsWith(".") || name === "node_modules" || name === "static-dist") return false
    if (!statSync(join(ROOT, name)).isDirectory()) return false
    if (!existsSync(join(ROOT, name, "package.json"))) return false
    if (filters.length && !filters.some((f) => name.includes(f))) return false
    if (script === "install") return true
    return Boolean(readPkg(join(ROOT, name))?.scripts?.[script])
  })

function run(name) {
  return new Promise((done) => {
    const chunks = []
    const child = spawn("pnpm", [script], {cwd: join(ROOT, name), shell: false})
    child.stdout.on("data", (d) => chunks.push(d))
    child.stderr.on("data", (d) => chunks.push(d))
    child.on("error", (err) => done({name, ok: false, output: `${err}\n`}))
    child.on("close", (code) =>
      done({name, ok: code === 0, output: Buffer.concat(chunks).toString("utf8")})
    )
  })
}

const queue = [...tools]
const failed = []

async function worker() {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const {ok, output} = await run(name)
    process.stdout.write(`\n── ${script} ${name} ──\n${output}`)
    if (!ok) failed.push(name)
  }
}

console.log(`running \`pnpm ${script}\` in ${tools.length} package(s)\n`)
await Promise.all(Array.from({length: CONCURRENCY}, worker))

if (failed.length) {
  console.error(`\n${failed.length} failed: ${failed.join(", ")}`)
  process.exit(1)
}
console.log(`\nall ${tools.length} passed`)
