# patchwork-base

A collection of the core tools that comprise the Patchwork system.

## Creating tools with an LLM

To create your own Patchwork tools with an LLM, install the `writing-patchwork-tools`
skill from [patchwork-skills](https://github.com/inkandswitch/patchwork-skills) into
your coding agent's skills directory:

```sh
npx @inkandswitch/patchwork-skills install <dir>   # e.g. .claude/skills or .cursor/skills
```

The skill teaches the agent the whole workflow — package registration, the render
contract, build & sync — and ships reference checkouts of this repo and
patchwork-experiments.

## Engineering Notes

Tools in this collection should be reliable and maintained: these are the core tools, after all.

Within a given distribution, it is reasonable to assume these tools exist, however tools in this collection should never assume the existence of other tools.

Regardless, these tools should not depend on each other's implementations or their internal structure.

Each directory in this collection can be built completely independently. Tools do not share lockfiles, node modules, or even necessarily build systems or web frameworks.

Please be careful not to violate these isolation principles.

## Dependencies

- External deps (`@inkandswitch/patchwork-*`, `solid-js`, etc.) are pinned to
  normal published npm versions.
- No tool depends on another folder in this repo. There is no root workspace
  and no root lockfile; each tool carries its own `pnpm-lock.yaml` and its own
  `pnpm-workspace.yaml` (which is only where pnpm 11 keeps per-package
  settings). `pnpm lint` fails on any `workspace:`/`catalog:`/`link:`/`file:`
  specifier, on a `pnpm-workspace.yaml` at the root, and on a root
  `pnpm-lock.yaml` that resolves any package or has been committed.
- When two tools genuinely need the same code, they become one package. A
  package registers as many plugins as it likes, so several tools and datatypes
  can ship from one folder — `account/` is the contact datatype and its views
  plus the account picker.

## Building one tool

```sh
cd history-view
pnpm install
pnpm build
```

That works from a copy of the folder anywhere on disk, with nothing else
checked out. If it doesn't, that's the bug.

## Building everything

From the repo root:

```sh
pnpm lint          # check nothing has been wired together
pnpm each install  # pnpm install in every tool
pnpm build         # pnpm build in every tool that has a build script
pnpm test          # pnpm test in every tool
```

`scripts/each.mjs` walks the top-level folders and runs `pnpm <script>` in each
one that declares it, up to CPUs-1 at a time, buffering each tool's output so
the interleaved logs stay readable. It exits non-zero if any tool failed.
Add `--filter <name>` to restrict it.

## Static-HTTP deployment (shell + tools bundle)

The tools can be deployed as a static HTTP bundle and loaded by any Patchwork
**shell** (the boot runtime). The two halves are independent:

- **Tools bundle** (lives here) — `static-dist/` (`modules.json` +
  `packages/<tool>/dist/…`), produced by `scripts/bundle.mjs`. Deployed to
  Netlify (the repo is private, so GitHub Pages would need a paid plan).
  `bundle` also writes a `_headers` file granting
  `Access-Control-Allow-Origin: *`, which Netlify (and Cloudflare Pages) honour
  so a shell can load these tools cross-origin.
- **Shell** (lives in `patchwork-next`) — there is no separate shell in this
  repo. Any patchwork-next site is a shell; `sites/tiny-patchwork` is the
  canonical one (PWA-ready). The static-manifest support lives in the bootloader
  (`ModuleWatcher` / `SiteConfig.defaultModules`), so a shell just needs to point
  its `defaultModules` at a tools host.

A shell can point at any tools host via `PATCHWORK_SYSTEM_PACKAGE_LIST_URL` (build time) or
`localStorage.systemPackageListURL` (runtime), so the same deployed shell can run
against an `automerge:` module-settings doc, this static tools bundle, a PR
preview, or a local tools server — no shell rebuild needed for the runtime
override.

### Build / serve / deploy the tools bundle

```sh
pnpm each install     # install every tool
pnpm build            # build every tool
pnpm bundle           # aggregate built tool dist/ -> static-dist/ + modules.json

pnpm build:static     # bundle whatever is already built
pnpm build:ci         # install + build every tool, then bundle

pnpm serve:tools      # serve static-dist/ on :4455 with CORS (local tools host)
pnpm dev:tools        # bundle + serve:tools

pnpm deploy:tools     # bundle + netlify deploy --prod (static-dist/)
```

A clean bundle from scratch is `pnpm build:ci` (which is exactly what Netlify
runs). One tool failing to build doesn't abort it — `bundle.mjs` skips any tool
with no built entry point, and `--strict` makes the whole thing exit non-zero.

`modules.json` uses relative `./packages/…` URLs that resolve against the
manifest's own URL, so the bundle works at any host or base path.

The first `pnpm deploy:tools` will prompt you to log in and link/create a
Netlify site (`netlify.toml` sets the publish dir). After that it's one command.

### Continuous deploy + PR previews (Netlify Git integration)

Our production deployment goes to Netlify, so we have included a `netlify.toml` for
convenience.

To aid in branch review, we have configured deploy previews on the GitHub repo.
The preview is of the _tools bundle_, so to test a PR's tools in any shell,
point it at the preview's manifest — no shell rebuild needed:

```js
localStorage.systemPackageListURL =
  "https://deploy-preview-123--<site>.netlify.app/modules.json";
```

### Run a shell against a local tools bundle

Local development can deploy as usual via pushwork, but to test the build process
you can always run a local webserver to host the JS and point your local shell at it.

```sh
# terminal 1 — tools host (in patchwork-base)
pnpm dev:tools

# terminal 2 — shell (in patchwork-next)
PATCHWORK_SYSTEM_PACKAGE_LIST_URL=http://localhost:4455/modules.json \
  pnpm --filter tiny-patchwork dev
```

At runtime you can also point an already-running/deployed shell at a tools host
without a rebuild:

```js
localStorage.systemPackageListURL = "http://localhost:4455/modules.json";
```

## Installing modules

To build a full set of modules for automerge-backed live development, run the usual install/build on all of them first. Once the tools are built, you can push each one to a module settings document using the following commands>

Right now this is a bit janky, but once you have the pushwork and the patchwork-modules CLI tool installed, you should be able to run:

```sh
export MODULE_SETTINGS_DOC_URL=`pw-modules init`
for tool in */package.json; do (cd "${tool%/*}" && pushwork init); done
pnpm each register
```

Of course, if you already have a patchwork modules document, you can supply it.
