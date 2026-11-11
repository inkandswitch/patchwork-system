// Initialize the automerge Wasm module before any test runs.
import "@automerge/automerge";

// happy-dom has no Web Animations API; the loading toast's pulse only needs
// the call not to throw.
Element.prototype.animate ??= function () {
  return { cancel() {} } as unknown as Animation;
};
