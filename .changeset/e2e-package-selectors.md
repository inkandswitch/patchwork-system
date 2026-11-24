---
"@inkandswitch/patchwork-e2e": patch
---

The install-tool spec finds the Packages tool by its current class names (`pw-pkg-packages__*`, `pw-pkg-install*`). pkg-base renamed them on 2026-11-12, and since then the spec failed on chromium waiting for a search box that was there under its new name.
