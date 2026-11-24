import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A package in a temporary directory, from its files' contents by path. */
export function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "patchwork-bundles-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const exportsTwoEntries = JSON.stringify({
  name: "fixture",
  type: "module",
  exports: {
    ".": { import: "./dist/index.js", source: "./src/index.ts" },
    "./tool": { import: "./dist/tools/tool.js", source: "./src/tool.tsx" },
    "./style.css": "./dist/index.css",
  },
});

/** A Solid package with two entries, the second in a subdirectory. */
export const solidPackage = {
  "package.json": exportsTwoEntries,
  "src/index.ts": `
    import { createSignal } from "solid-js";
    export const plugins = [{ id: "tool", load: () => import("./tool.tsx") }];
    export const [count] = createSignal(0);
  `,
  "src/tool.tsx": `
    import { createSignal } from "solid-js";
    import { label } from "./label.ts";
    export default function Tool(props: { name: string }) {
      const [n] = createSignal<number>(1);
      return <div class="tool">{label(props.name)} {n()}</div>;
    }
  `,
  "src/label.ts": `export const label = (name: string): string => name.toUpperCase();`,
  "src/react.tsx": `/** @jsxImportSource react */
    export const R = () => <span>react</span>;
  `,
};

/** The same two entries with no JSX, for bundlers that don't compile it. */
export const plainPackage = {
  "package.json": exportsTwoEntries,
  "src/index.ts": `
    import { createSignal } from "solid-js";
    export const plugins = [{ id: "tool", load: () => import("./tool.tsx") }];
    export const [count] = createSignal(0);
  `,
  "src/tool.tsx": `
    import { createSignal } from "solid-js";
    export default function tool(name: string): string {
      const [n] = createSignal<number>(1);
      return name.toUpperCase() + n();
    }
  `,
};

/** A stand-in solid-js in the package's node_modules, for bundling. */
export const ownSolid = {
  "node_modules/solid-js/package.json": JSON.stringify({
    name: "solid-js",
    type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  }),
  "node_modules/solid-js/index.js": `
    export const createSignal = (v) => [() => v, (n) => (v = n)];
    export const OWN_SOLID = "bundled";
  `,
};
