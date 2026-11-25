---
"@inkandswitch/patchwork": patch
---

Boot finds the account's root folder and every folder under it before it loads any of the account's own packages. It follows only links whose type is `folder`, never the files in them, a level at a time, skipping a folder it can't find. If the folders take longer than 3s, the packages load anyway and the remaining folders keep loading in the background. The site's own packages aren't held up: they start before the account is open, as before.

`BootProgress` gets `folders: { found, done }`, so a site drawing its own boot screen can say how many folders have been found so far. The built-in boot status box shows "Your folders: N loaded so far" until they've all been found.
