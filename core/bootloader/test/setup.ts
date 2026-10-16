// The fat entry points initialize their Wasm on import; everything under test
// imports the slim ones, which share the same module.
import "@automerge/automerge";
import "@automerge/automerge-subduction";
