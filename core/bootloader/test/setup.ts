// Initialize both Wasm modules before any test runs.
// automerge-repo@subduction.9 always creates a SubductionSource,
// which imports from @automerge/automerge-subduction/slim — the
// Wasm must be initialized first.
//
// Importing the fat entry points auto-calls initSync / UseApi().
// The vitest.config.ts resolve aliases ensure a single copy is used
// even when automerge-repo is linked locally.
import "@automerge/automerge";
import "@automerge/automerge-subduction";
