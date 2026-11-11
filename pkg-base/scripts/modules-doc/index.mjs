#!/usr/bin/env node
import {existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs"
import {execFile, fork} from "node:child_process"
import {promisify} from "node:util"
import {join, dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {Repo, initSubduction} from "@automerge/automerge-repo"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const SYNC_SERVER = process.env.PUSHWORK_SUBDUCTION_SERVER ?? "wss://subduction.sync.inkandswitch.com"

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const outDir = resolve(ROOT, arg("dir", "static-dist"))
const packagesDir = join(outDir, "packages")
const concurrency = Number(arg("concurrency", 6))

if (!existsSync(packagesDir)) {
  console.error(`${packagesDir} not found`)
  process.exit(1)
}

const names = readdirSync(packagesDir, {withFileTypes: true})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

// `--shape`, `--artifact-dir` and the global `--silent` all arrived in pushwork
// 2. A 1.x on PATH fails every package with `unknown option`, so say so once.
const version = (await promisify(execFile)("pushwork", ["--version"])).stdout.match(/^pushwork\s+(\S+)/)?.[1]
if (!version || Number(version.split(".")[0]) < 2) {
  console.error(`pushwork 2 or newer required, found ${version ?? "no version"} — npm install -g pushwork@latest`)
  process.exit(1)
}

async function pushworkInit(name) {
  const dir = join(packagesDir, name)
  rmSync(join(dir, ".pushwork"), {recursive: true, force: true})
  const flags = ["--silent", "init", "--shape", "patchwork-folder"]
  if (existsSync(join(dir, "dist"))) flags.push("--artifact-dir", "dist")
  await promisify(execFile)("pushwork", [...flags, "."], {cwd: dir})
  return JSON.parse(readFileSync(join(dir, ".pushwork", "config.json"), "utf8")).rootUrl
}

const urls = new Map()
const failed = []
const queue = [...names]
await Promise.all(
  Array.from({length: concurrency}, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      try {
        urls.set(name, await pushworkInit(name))
        console.error(`[ok]    ${name} ${urls.get(name)}`)
      } catch (err) {
        failed.push(name)
        console.error(`[fail]  ${name}\n${err.stderr || err.message}`)
      }
    }
  })
)

if (failed.length) {
  console.error(`\n${failed.length} failed: ${failed.join(", ")}`)
  process.exit(1)
}

const registry = {
  "@patchwork": {type: "patchwork:plugin-registry"},
  "patchwork:tool": {},
  "patchwork:datatype": {},
}
const plugins = await new Promise((done, fail) => {
  const child = fork(join(dirname(fileURLToPath(import.meta.url)), "plugins.mjs"), [packagesDir], {stdio: "ignore"})
  child.on("message", done)
  child.on("exit", (code) => fail(new Error(`plugins.mjs exited with ${code}`)))
})
for (const name of names) {
  if (plugins[name]?.error) {
    console.error(`[warn]  ${name} plugins unreadable, left out of the registry: ${plugins[name].error}`)
    continue
  }
  for (const {type, id} of plugins[name]?.plugins ?? []) {
    registry[type] ??= {}
    if (registry[type][id]) console.error(`[warn]  ${type} ${id} provided twice, ${name} wins`)
    registry[type][id] = urls.get(name)
  }
}

await initSubduction()
const repo = new Repo({subductionWebsocketEndpoints: [SYNC_SERVER]})

const moduleSettings = repo.create({
  "@patchwork": {type: "patchwork:module-settings"},
  modules: names.map((name) => urls.get(name)),
})
const pluginRegistry = repo.create(registry)

async function waitForServer(handle, deadline = Date.now() + 30_000) {
  let nudged = false
  const start = Date.now()
  while (Date.now() < deadline) {
    const [peer] = repo.isSubductionConnected() ? await repo.connectedSubductionPeerIds() : []
    const advertised = peer ? handle.getSyncInfo(peer)?.lastHeads ?? [] : []
    if (advertised.length && handle.heads().every((h) => advertised.includes(h))) return true
    if (peer && !nudged && Date.now() - start > 6_000) {
      nudged = true
      repo.resyncSubduction(handle.documentId)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

for (const handle of [moduleSettings, pluginRegistry]) {
  if (!(await waitForServer(handle))) console.error(`warning: sync server hasn't confirmed ${handle.url} yet`)
}

await repo.flush()
await Promise.race([repo.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])

writeFileSync(join(outDir, "module-settings-url"), moduleSettings.url + "\n")
writeFileSync(join(outDir, "plugin-registry-url"), pluginRegistry.url + "\n")
writeFileSync(join(outDir, ".npmignore"), ".pushwork\n")

console.log(`module-settings-url ${moduleSettings.url}`)
console.log(`plugin-registry-url ${pluginRegistry.url}`)
process.exit(0)
