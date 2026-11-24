import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../src/theme.css", import.meta.url)),
  "utf8"
);

/** The big `:root, :host, [theme] { ... }` token block, comments stripped. */
const tokenBlock = (() => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = text.indexOf("[theme] {") + "[theme] {".length;
  let depth = 1;
  let end = start;
  while (depth > 0 && end < text.length) {
    if (text[end] === "{") depth++;
    if (text[end] === "}") depth--;
    end++;
  }
  return text.slice(start, end - 1);
})();

const declarations = [
  ...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]*);/gm),
].map(([, name, value]) => ({ name, value: value.trim() }));
const defined = new Set(declarations.map((d) => d.name));

describe("theme.css tokens", () => {
  // a comment that says */ ends early, and the rest of it is read as a broken
  // declaration that swallows the real one after it
  it("closes no comment early", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("*/");
  });

  it("has no custom property that refers to itself", () => {
    const cycles = declarations.filter(({ name, value }) =>
      value.includes(`var(${name})`)
    );
    expect(cycles).toEqual([]);
  });

  it("declares each custom property once", () => {
    const seen = new Map<string, number>();
    for (const { name } of declarations)
      seen.set(name, (seen.get(name) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("feeds syntax fills from the text fill and styles from the text style", () => {
    const swapped = declarations.filter(
      ({ name, value }) =>
        (name.startsWith("--syntax-fill-") &&
          value === "var(--text-editor-text-style)") ||
        (name.startsWith("--syntax-style-") &&
          value === "var(--text-editor-text-fill)")
    );
    expect(swapped).toEqual([]);
  });

  // opt-in tokens must stay undefined, so tools' var(--token, <their own>)
  // fallbacks keep winning until a theme sets them.
  it.each([
    "--studio-focus-ring",
    "--studio-focus-ring-offset",
    "--studio-hover-fill",
    "--studio-active-fill",
    "--studio-chrome-hover-fill",
    "--studio-chrome-active-fill",
    "--studio-chrome-letter-spacing",
    "--studio-letter-spacing",
    "--studio-font-features",
    "--studio-font-variation",
    "--studio-heading-family",
    "--studio-heading-weight",
    "--studio-font-scale",
    "--studio-backdrop",
    "--studio-backdrop-blur",
    "--studio-scrollbar-color",
    "--studio-scrollbar-width",
    "--studio-layer-raised",
    "--studio-layer-dropdown",
    "--studio-layer-overlay",
    "--studio-layer-modal",
    "--studio-layer-popover",
    "--studio-layer-toast",
    "--studio-layer-tooltip",
  ])("leaves opt-in %s undefined", (name) => {
    expect(defined.has(name)).toBe(false);
  });

  it("keeps heading sizes invalid until a font scale is set", () => {
    for (let n = 1; n <= 6; n++) {
      const decl = declarations.find(
        (d) => d.name === `--studio-heading-size-${n}`
      );
      expect(decl?.value).toContain("var(--studio-font-scale)");
    }
  });

  it.each([
    ["--studio-density", "1"],
    ["--studio-radius-scale", "1"],
    ["--studio-shadow-strength", "1"],
    ["--studio-motion-scale", "1"],
    ["--studio-motion-preference", "1"],
    ["--studio-border-width", "1px"],
    ["--studio-border-style", "solid"],
    ["--studio-cursor-pointer", "pointer"],
    ["--studio-disabled-opacity", "0.5"],
  ])("defaults %s to %s so existing output is unchanged", (name, value) => {
    expect(declarations.find((d) => d.name === name)?.value).toBe(value);
  });

  it("only references studio tokens that exist or are documented opt-ins", () => {
    const optIn = new Set(["--studio-font-scale"]);
    const referenced = new Set(
      [...tokenBlock.matchAll(/var\((--studio-[a-z0-9-]+)\)/g)].map(
        ([, n]) => n
      )
    );
    const missing = [...referenced].filter(
      (n) => !defined.has(n) && !optIn.has(n)
    );
    expect(missing).toEqual([]);
  });
});
