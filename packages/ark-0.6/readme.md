# @inkandswitch/patchwork-ark-0.6

The previous generation of the keyhive stack, pinned together:
`@automerge/automerge-repo-keyhive` 0.6.0-alpha.1, `@keyhive/keyhive`
0.3.0-alpha.1, `@automerge/automerge-repo` (and adapters, `vanillajs`)
2.6.0-subduction.48, and `@automerge/automerge-subduction` 0.16.1.

There's no code here. A Patchwork site built with
`patchwork({ keyhive: { ark: "0.6" } })` resolves every one of these packages
from this package's dependencies instead of the current ones, so the build
talks to sync servers still running ARK 0.6. Its dependency list is the
definition of the stack: anything listed here is swapped in.

`@inkandswitch/patchwork` already depends on this; a site doesn't install it
itself. Delete it once no server runs 0.6.
