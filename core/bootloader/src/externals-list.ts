/**
 * these dependencies will be built into the outdir, and injected into the importmap
 */
const externals = [
  "@automerge/automerge",
  "@automerge/automerge/slim",
  "@automerge/automerge-repo",
  "@automerge/automerge-repo/slim",
  "@automerge/automerge-repo/sedimentree",
  "@automerge/automerge-repo-subduction",
  "@automerge/automerge-repo-subduction-network-websocket",
  "@automerge/automerge-repo-subduction-storage-indexeddb",
  "@automerge/subduction",
  "@automerge/subduction/slim",
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

export const slim: Record<string, string> = {
  "@automerge/automerge": "@automerge/automerge/slim",
  "@automerge/automerge-repo": "@automerge/automerge-repo/slim",
  "@automerge/subduction": "@automerge/subduction/slim",
  "@keyhive/keyhive": "@keyhive/keyhive/slim",
};
