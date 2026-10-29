---
"@inkandswitch/patchwork-filesystem": patch
"@inkandswitch/patchwork-bootloader": patch
"@inkandswitch/patchwork": patch
---

Fixes to paths, packages and the content store from review.

- File lists: a file named `__proto__` is listed like any other. A tail named like an `Object.prototype` member (`constructor`, `toString`) that the list doesn't name answers 404.
- Pinning through a package's container (a path provider's doc) lists that container, so the URL serves. A doc named by a doc step is walked with package providers; one a path ends at by name is still a container or a file by the built-ins.
- A value held by a doc below a package's root (a nested directory doc) is listed with that doc's heads, and read back at them.
- `/packages`:
  - a package that's a branches doc reloads when its default branch's code changes, and follows the branch when it moves;
  - a member folder that can't be found doesn't hold up the others: the first listing waits up to 3s, then lists what it has, and the rest arrive as they're found;
  - migration records the entries it moved in the module-settings doc (`movedToPackages`). This build loads those only through `/packages`, so removing a package there removes it. Builds that predate `/packages` still read `modules` as before;
  - migration never gives two packages one name, and a `/packages` binding that syncs in mid-migration wins;
  - boot waits at most a second for migration.
- Routing:
  - a `doc=`/`path=` check that finishes after the hash moved on leaves the new hash alone;
  - opening another part of the same document drops the path;
  - a path-only hash that doesn't resolve is walked again when path providers register, so a cold boot opens a path through a package's datatype.
- The service worker opens an account's content store only to write to it, so a `/@/` link naming an unknown account leaves no cache behind.
