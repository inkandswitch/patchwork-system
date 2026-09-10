// Initialize both Wasm modules before any test runs: constructing a `Repo`
// creates a SubductionSource, which imports @automerge/automerge-subduction/slim
// and needs the Wasm already up. Importing the fat entry points does that.
import "@automerge/automerge";
import "@automerge/automerge-subduction";
