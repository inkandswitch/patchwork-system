# @inkandswitch/patchwork-bundles

The build a Patchwork package shares, as one plugin for esbuild, vite or
rollup. It reads the package's `package.json` and builds each export that has
a `source` to the file its `import` names:

```json
"exports": {
  ".": { "import": "./dist/main.js", "source": "./src/main.ts" },
  "./tool": { "import": "./dist/tool.js", "source": "./src/tool.tsx" },
  "./style.css": "./dist/index.css"
}
```

builds `src/main.ts` to `dist/main.js` and `src/tool.tsx` to `dist/tool.js`.
`./style.css` has no `source`, so it's left alone.

## Use

### esbuild

```ts
// build.ts
import * as esbuild from "esbuild";
import patchwork from "@inkandswitch/patchwork-bundles/esbuild";

const context = await esbuild.context({ plugins: [patchwork()] });
if (process.argv.includes("--watch")) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
```

```json
"scripts": {
  "build": "node build.ts",
  "dev": "node build.ts --watch",
  "pushwatch": "node build.ts --watch pushwork"
}
```

That replaces a package's `esbuild/` folder (`options.ts`, `plugin-solid.ts`,
`jsx-comments.ts`, `plugin-pushwork-sync.ts`). For Solid, add one of the
[Solid plugins](#solid-with-esbuild).

### vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import patchwork from "@inkandswitch/patchwork-bundles/vite";

export default defineConfig({ plugins: [patchwork()] });
```

It replaces `base: "./"`, the externals, and the `rollupOptions` input and
output names. A build with `build.lib` or its own `rollupOptions.input` keeps
its entries and gets everything else. It compiles no JSX: keep
`vite-plugin-solid` (Solid 1) or `@solidjs/vite-plugin` (Solid 2).

### rollup

```js
// rollup.config.js
import patchwork from "@inkandswitch/patchwork-bundles/rollup";

export default { plugins: [patchwork()] };
```

Rollup reads no TypeScript by itself, so a TypeScript package still needs a
plugin for that.

## What it does

With no build options of your own, in each bundler, it:

- builds each export's `source` to its `import`, into the directory the
  imports share (`dist`)
- bundles for the browser as split ES modules with sourcemaps
- leaves the modules the host provides through its importmap as bare imports
  (`@inkandswitch/patchwork-bootloader/externals-list`: automerge, solid-js,
  the patchwork packages…)
- empties the outdir before each build
- runs `pushwork sync` after each build that ends without errors, when the
  command has a `pushwork` argument or `PUSHWORK` is set

With esbuild it also inlines `.ttf` fonts as data URLs and resolves the
`style` condition. With vite it builds with `base: "./"`, so the files work
wherever the host serves them from, and targets `esnext`.

Any option you pass wins. `external` (and esbuild's `loader`) are added to
the defaults rather than replacing them. So a React esbuild package passes
`{ jsx: "automatic", jsxImportSource: "react" }`, one that imports CSS as a
string passes `{ loader: { ".css": "text" } }`, and one with a single entry
that loads everything else lazily passes `{ entryPoints: ["src/index.tsx"] }`.

## Options

```ts
patchwork({
  // the directory with the package.json. defaults to the bundler's root
  // (esbuild's absWorkingDir, vite's root), or the current directory
  root: "./",
  // modules the host provides that this package bundles its own copy of,
  // by package name. "solid-js" covers every solid-js/… subpath too
  bundle: [],
  // sync with pushwork after each good build. defaults to the `pushwork`
  // argument or PUSHWORK
  pushwork: false,
});
```

## Solid with esbuild

Two esbuild plugins compile Solid's JSX, one for each Solid. Each leaves a
file that starts with `/** @jsxImportSource react */` (or any other source
that isn't Solid's) to esbuild.

### Solid 1: `/esbuild/solid1`

```ts
import patchwork from "@inkandswitch/patchwork-bundles/esbuild";
import solid from "@inkandswitch/patchwork-bundles/esbuild/solid1";

await esbuild.build({ plugins: [patchwork(), solid()] });
```

This is the Solid the host provides, so `solid-js` comes from its importmap.
It compiles with babel-preset-solid, and takes that preset's options
(`solid({ generate, hydratable })`). The preset can't read TypeScript, so a
`.tsx` file has its types stripped by `esbuild.transform` first. That doesn't
read `tsconfig.json`, so under `verbatimModuleSyntax` an import of nothing but
types (`import { type A } from "x"`) is dropped rather than kept as
`import "x"`.

### Solid 2: `/esbuild/solid2`

```ts
import patchwork from "@inkandswitch/patchwork-bundles/esbuild";
import solid from "@inkandswitch/patchwork-bundles/esbuild/solid2";

await esbuild.build({
  plugins: [patchwork({ bundle: ["solid-js"] }), solid()],
});
```

It compiles with `@solidjs/compiler`, the one Solid 2's own vite plugin uses,
and takes its options. The compiled code imports `@solidjs/web`. TypeScript is
left in for esbuild to strip, with the package's tsconfig.

The host provides Solid 1, so a Solid 2 package bundles its own: install
`solid-js@2` and `@solidjs/web`, and pass `bundle: ["solid-js"]`. Without
that, the build fails rather than running against the host's Solid 1. Anything
else the package bundles that's built on Solid 1 (`solid-automerge`, say) runs
against its Solid 2 and may not work.
