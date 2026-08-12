/**
 * these dependencies will be built into the outdir, and injected into the importmap
 */
const externals = [
  "@automerge/automerge",
  "@automerge/automerge/slim",
  "@automerge/automerge-repo",
  "@automerge/automerge-repo/slim",
  // Port-donation plumbing: a tab opens a port on the subduction worker and
  // donates it to the automerge worker, since a SharedWorker can neither spawn
  // nor connect to another one. See setup.ts/automerge-worker.ts.
  "@automerge/automerge-repo/worker-port",
  "@automerge/automerge-repo-network-messagechannel",
  "@automerge/automerge-repo-network-websocket",
  "@automerge/automerge-repo-storage-indexeddb",
  "@automerge/automerge-repo-keyhive",
  "@automerge/automerge-subduction",
  "@automerge/automerge-subduction/slim",
  "@keyhive/keyhive",
  "@keyhive/keyhive/slim",
  "@inkandswitch/patchwork-bootloader",
  "@inkandswitch/patchwork-elements",
  "@inkandswitch/patchwork-filesystem",
  "@inkandswitch/patchwork-plugins",
  "@inkandswitch/patchwork-providers",
  "@inkandswitch/patchwork",

  // sad
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
  "@codemirror/commands",

  // rip
  "solid-js",
  "solid-js/html",
  "solid-js/web",
  "solid-js/h",
  "solid-js/store",
  "solid-js/jsx-runtime",
];
export default externals;
