import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { Repo } from "@automerge/automerge-repo/slim";

export const plugins = [
  {
    type: "patchwork:tool",
    id: "sync-indicator",
    tags: ["titlebar-tool"],
    name: "Sync Indicator",
    icon: "Wifi",
    supportedDatatypes: "*" as const,
    unlisted: true,
    forTitleBar: true,
    async load(): Promise<ToolImplementation> {
      const { renderSyncIndicator } = await import("./SyncIndicator");
      return renderSyncIndicator;
    },
  },
//  {
//    // The system-tray sibling of the titlebar tool: one indicator per currently
//    // selected doc, read from the ancestor SelectedDocProvider. A component (not
//    // a tool) because it takes no doc of its own — it's mounted with `(element,
//    // repo)` and resolves the selection itself.
//    type: "patchwork:component",
//    id: "sync-tray",
//    tags: ["system-tray"],
//    name: "Sync",
//    icon: "Wifi",
//    async load() {
//      const { render } = await import("solid-js/web");
//      const { SyncTray } = await import("./SyncTray");
//      const { RepoContext } = await import("./SyncIndicator");
//      return (element: HTMLElement, repo: Repo) => {
//        const dispose = render(
//          () => (
//            <RepoContext.Provider value={repo}>
//              <SyncTray element={element} />
//            </RepoContext.Provider>
//          ),
//          element
//        );
//        return () => dispose();
//      };
//    },
//  },
];
