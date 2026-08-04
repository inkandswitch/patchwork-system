# AGENTS.md

## Changesets

This is a changesets monorepo. Every published package under `core/` and `packages/` is versioned and released from `.changeset/`.

If you change the source of a published package, add a changeset in the same batch of work. Write it yourself with the Write tool — don't run `pnpm changeset`, it's interactive.

`.changeset/<some-name>.md`:

```markdown
---
"@inkandswitch/patchwork-bootloader": patch
---

Describe what changed and why, in the present tense, for someone reading the changelog. Not "fixed a bug".
```

- One changeset per coherent change, listing every package it touches. Not one per package, not one per commit.
- Pick the filename yourself; any kebab-case name works as long as it's not already taken.
- Bump levels: everything here is pre-1.0, so `patch` is the default — fixes, internal changes, and new API all get `patch`. `minor` only for a breaking change. `major` only when asked.
- If a package's public API changed, say what moved and what to import instead.

Skip the changeset when nothing published changed — `sites/`, `e2e/`, `scripts/`, config, docs, tests.

### Catalog bumps

Bumping a version in the `catalog:` block of `pnpm-workspace.yaml` needs a changeset too. `catalog:` is resolved to a concrete version at publish time, so it rewrites the published manifest.

Which packages to list: every published package that has the bumped entry in its `dependencies` or `peerDependencies`. Packages that only have it in `devDependencies` don't need a bump — their tarball is unchanged, and their `.d.ts` resolve the types against whatever the consumer installed.

The `@automerge/*` and `@keyhive/*` entries are exact pins, not ranges. Two of our packages published against different pins means two copies of automerge-repo in the consumer's tree, which breaks document handle identity. Bump them together in one changeset and say which version they moved to.
