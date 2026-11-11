# Vendored: @automerge/automerge-codemirror

Copied from https://github.com/automerge/automerge-codemirror
(local checkout `/Users/paul/repos/automerge-codemirror`), version 0.3.0,
commit `0b2b629fe98847346ec60795e301c73e6435486e`. MIT licensed.

Vendored so codemirror-base can use the unpublished 0.3.0 (`scopeReplaced`
support for reloadable doc handles) without an npm release. Keep edits
upstream and re-copy `src/*.ts` rather than patching in place.

The only local deviations are mechanical, to satisfy this package's
`verbatimModuleSyntax` and `erasableSyntaxOnly` compiler options: type-only
imports are marked `import type`, and constructor parameter properties are
written as explicit field assignments. Re-apply these after a re-copy.
