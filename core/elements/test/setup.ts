// Initialize both Wasm modules before any test runs: constructing a `Repo`
// creates a SubductionSource, which imports @automerge/automerge-subduction/slim
// and needs the Wasm already up. Importing the fat entry points does that.
import "@automerge/automerge";
import "@automerge/automerge-subduction";

// happy-dom has no Web Animations API; the loading toast's pulse only needs
// the call not to throw.
Element.prototype.animate ??= function () {
  return { cancel() {} } as unknown as Animation;
};
