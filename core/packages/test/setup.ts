// Initialize both Wasm modules before any test runs, as core/filesystem does:
// automerge-repo always creates a SubductionSource, which imports from
// @automerge/automerge-subduction/slim.
import "@automerge/automerge";
import "@automerge/automerge-subduction";
