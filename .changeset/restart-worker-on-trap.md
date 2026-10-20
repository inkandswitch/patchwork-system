---
"@inkandswitch/patchwork-bootloader": patch
---

The automerge worker restarts itself when it's broken, rather than carrying on holding its lock while every request fails: when a wasm instance traps (`WebAssembly.RuntimeError`, which is how subduction's panics and running out of memory arrive, thrown uncaught or logged by whatever caught it, or the panic hook's `panicked at`), or when its sync node or Repo fails to start. Each time is reported in the tabs' consoles. A failing worker doesn't finish its in-flight work or save its documents first, since that would use an instance whose memory may be half-changed; it closes straight away and the tabs start a replacement, which took 0.2s. An automerge `PanicError` doesn't count: automerge unwinds, so the instance carries on.

`startWorkerControl` returns `fail(reason, error)`, and `isWasmTrap` is exported, for any SharedWorker to do the same.
