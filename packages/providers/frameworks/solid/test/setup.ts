// Initialize the WASM modules that automerge-repo@subduction depends on
// before any test runs. Importing the fat entry points auto-calls
// initSync / UseApi().
import "@automerge/automerge";
import "@automerge/automerge-subduction";
