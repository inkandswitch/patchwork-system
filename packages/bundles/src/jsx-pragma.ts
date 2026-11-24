import { parse } from "@babel/parser";

/**
 * The `@jsx*` settings in a file's leading block comments, keyed by lowercased
 * name: `/** @jsxImportSource react *\/` gives `{ importsource: "react" }`.
 *
 * TypeScript, babel, esbuild and react each read these comments slightly
 * differently. This reads only block comments that come before the first
 * statement, which is the subset they all agree on.
 */
export function jsxPragmas(source: string): Record<string, string> {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: true,
  });
  const firstCode = ast.program.body[0]?.start ?? Infinity;
  const pragmas: Record<string, string> = {};
  for (const comment of ast.comments ?? []) {
    if (comment.type != "CommentBlock" || comment.end! > firstCode) continue;
    for (const match of comment.value.matchAll(/@jsx(\S+)\s+(\S+)/gi)) {
      pragmas[match[1].toLowerCase()] = match[2];
    }
  }
  return pragmas;
}

/**
 * The import source a file asks for with `@jsxImportSource`, if it uses the
 * automatic runtime. A file with `@jsxRuntime classic` gets `undefined` too.
 */
export function jsxImportSource(source: string): string | undefined {
  const pragmas = jsxPragmas(source);
  if (pragmas.runtime && pragmas.runtime != "automatic") return;
  return pragmas.importsource;
}
