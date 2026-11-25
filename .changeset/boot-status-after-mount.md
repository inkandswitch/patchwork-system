---
"@inkandswitch/patchwork": patch
---

The boot status box in the corner stays up after the first view mounts, while the rest of the packages are still loading, and says how many are in and which loaded last. It goes once every listed package has loaded, or 30s after the view mounted if one never does. Since boot started opening the first view before every package was in, the box went away while packages were still loading behind it. Once the view is up the box no longer counts towards being stuck, and drops its reload button.
