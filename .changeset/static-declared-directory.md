---
"@inkandswitch/patchwork": patch
---

Say what's actually wrong when a `static` package declares a directory that
isn't there. The package resolved fine — its `"patchwork": {"static": …}` field
is what's wrong — and "static source not found" named neither the field nor the
path it pointed at. The error now quotes the declaration, gives the full path
that's missing, and says that a package publishing its static tree as the root
of its own tarball shouldn't set the field at all.
