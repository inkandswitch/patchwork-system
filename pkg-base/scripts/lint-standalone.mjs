#!/usr/bin/env node
// Standalone-package linter.
//
// Every package in this repo must be pullable on its own: you should be able to
// copy one folder out, run `pnpm install` + the build inside it, and get the
// same result. That breaks the moment a package leans on something only its
// neighbours provide, or ships without the files that pin its own install.
//
// Checked, for every folder with a package.json (nested ones included):
//
//   1. No workspace-only dependency specifiers, in any dependency field:
//        workspace:*  - pnpm workspace protocol; only resolvable in a workspace
//        catalog:*    - pnpm catalog protocol; version lives outside the package
//        link:../x    - symlink to a sibling folder; gone once the folder is alone
//        file:../x    - tarball/dir reference that escapes the package folder
//
//   2. A committed pnpm-lock.yaml and pnpm-workspace.yaml. The lockfile is the
//      install; the workspace file is where pnpm 11 keeps per-package settings
//      (minimumReleaseAge, allowBuilds, verifyDepsBeforeRun). A package that
//      gitignores either one looks fine on the machine that made it and is
//      broken in a fresh clone, which is the only case that counts.
//
//   3. Nothing at the repo root that would re-link the packages together: no
//      pnpm-workspace.yaml, and no pnpm-lock.yaml that resolves any package or
//      has been committed. (Running a root script leaves an empty lockfile
//      behind; it's gitignored and inert, so it's tolerated on disk only.)
//
// Run from the repo root: `node scripts/lint-standalone.mjs` (or `pnpm lint`).

import fs from "node:fs"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const git = (...args) => {
  try {
    return execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim()
  } catch {
    return "" // no git here, or no match — callers treat both as "nothing"
  }
}

// Tracked, as far as git is concerned: committed, or staged to be.
const tracked = new Set(git("ls-files").split("\n"))

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]

// specifier -> human-readable reason
const FORBIDDEN = [
  [/^workspace:/, "uses the pnpm `workspace:` protocol"],
  [/^catalog:/, "uses the pnpm `catalog:` protocol (version defined outside the package)"],
  [/^link:/, "uses `link:` to a sibling folder"],
  [/^file:/, "uses `file:` to a path outside the package"],
]

// what every package has to carry itself
const REQUIRED = [
  ["pnpm-lock.yaml", "this package's install isn't reproducible without it"],
  [
    "pnpm-workspace.yaml",
    "this is where pnpm 11 reads minimumReleaseAge / allowBuilds / verifyDepsBeforeRun",
  ],
]

// files that would turn the repo back into one big install
const ROOT_FILES = [
  {
    file: "pnpm-workspace.yaml",
    offending: () => true,
    reason: "would make every package a workspace project again",
  },
  {
    file: "pnpm-lock.yaml",
    offending: (contents) => /^packages:/m.test(contents),
    reason: "resolves dependencies at the root, where nothing should install",
    trackedReason: "is committed at the root, where nothing should install",
  },
]

const SKIP_DIRS = new Set(["node_modules", "dist", "static-dist"])

function packageDirs() {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const at = path.join(dir, entry.name)
      // keep walking past a package — packages can nest (tasks/src/in-the-cloud)
      if (fs.existsSync(path.join(at, "package.json"))) found.push(path.relative(root, at))
      walk(at)
    }
  }
  walk(root)
  return found.sort()
}

// Why isn't this file committed? The gitignore case is the one worth naming:
// it's invisible on the machine that made it.
function whyNotCommitted(rel) {
  const ignoredBy = git("check-ignore", "-v", "--", rel).split("\t")[0]
  if (ignoredBy) return `is gitignored (${ignoredBy}), so a fresh clone won't have it`
  if (!fs.existsSync(path.join(root, rel))) return "is missing"
  return "exists but isn't committed"
}

const violations = []

for (const {file, offending, reason, trackedReason} of ROOT_FILES) {
  const at = path.join(root, file)
  const isTracked = tracked.has(file)
  if (!isTracked && !(fs.existsSync(at) && offending(fs.readFileSync(at, "utf8")))) continue
  violations.push({
    what: file,
    reason: isTracked ? (trackedReason ?? reason) : reason,
    fix: `\`git rm --cached ${file}\` if it's tracked, then delete it.`,
  })
}

for (const name of packageDirs()) {
  const pjPath = path.join(root, name, "package.json")
  let pj
  try {
    pj = JSON.parse(fs.readFileSync(pjPath, "utf8"))
  } catch (err) {
    violations.push({
      what: `${name}/package.json`,
      reason: `is not valid JSON: ${err.message}`,
      fix: "fix the syntax.",
    })
    continue
  }

  for (const field of DEP_FIELDS) {
    const deps = pj[field]
    if (!deps || typeof deps !== "object") continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue
      for (const [re, reason] of FORBIDDEN) {
        if (!re.test(spec)) continue
        violations.push({
          what: `${name}/package.json → ${field}.${dep}`,
          detail: `"${spec}"`,
          reason,
          fix: "replace with a registry version range, or move the shared code into this package.",
        })
      }
    }
  }

  for (const [file, why] of REQUIRED) {
    const rel = `${name}/${file}`
    if (tracked.has(rel)) continue
    violations.push({
      what: rel,
      reason: `${whyNotCommitted(rel)} — ${why}`,
      fix: `un-ignore it, run \`pnpm install\` in ${name}, and commit it.`,
    })
  }
}

if (violations.length === 0) {
  console.log("✓ every package installs on its own")
  process.exit(0)
}

console.error(`✗ found ${violations.length} thing(s) tying the packages together:\n`)
for (const v of violations) {
  console.error(`  ${v.what}`)
  console.error(`    ${v.detail ? `${v.detail}  ` : ""}${v.reason}`)
  console.error(`    fix: ${v.fix}\n`)
}
process.exit(1)
