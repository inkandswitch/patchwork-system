---
"@inkandswitch/patchwork": patch
---

Once every package has loaded, the site's and the account's, boot finds the account's root folder and every folder under it in the background, so the sidebar has them to hand. It follows only links whose type is `folder`, never the files in them, a level at a time, skipping a folder it can't find. No package waits on the folders, and nothing in boot waits on them either.

`BootProgress` gets `folders: { found, done }`, so a site drawing its own boot screen can say how many folders have been found so far. The built-in boot status box shows "Your folders: N loaded so far" while it's still up and they haven't all been found.
