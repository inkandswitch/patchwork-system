// Static (not lazy): the only reference that makes esbuild emit dist/index.css
// as a build artifact. It's plain CSS text (not a JS runtime), so — unlike
// solid-js/web below — it's fine for the entry to reference it directly.
import "./index.css";
import { type ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import type { SideboardAccountDoc } from "./types.ts";

async function loadStyles() {
  const url = new URL("./index.css", import.meta.url);
  return (await fetch(url)).text();
}

function addStyles(textContent: string) {
  const id = "sideboard-styles";
  const el =
    document.head.querySelector(`#${id}`) ?? document.createElement("style");
  Object.assign(el, { textContent, id });
  document.head.append(el);
}

const doclist = {
  id: "chee/document-list",
  type: "patchwork:tool",
  name: "Document List",
  supportedDatatypes: ["folder"],
  icon: "FolderOpen",
  unlisted: true,
  async load(): Promise<ToolImplementation<FolderDoc>> {
    const [{ renderDocumentListPanel }, styles] = await Promise.all([
      import("./sideboard/document-list-panel.tsx"),
      loadStyles(),
    ]);
    return (handle, element) => {
      addStyles(styles);
      return renderDocumentListPanel(handle.url, element);
    };
  },
};

export const plugins = [
  doclist,
  Object.assign({}, doclist, {
    id: "folder-tree-view",
    name: "Folder Tree View",
    icon: "Tree",
    unlisted: false
  }),
  {
    id: "chee/account-bar",
    type: "patchwork:tool",
    name: "Account Bar",
    supportedDatatypes: ["account"],
    icon: "UserCircle",
    unlisted: true,
    async load(): Promise<ToolImplementation<SideboardAccountDoc>> {
      const [{ renderAccountBar }, styles] = await Promise.all([
        import("./sideboard/account-bar.tsx"),
        loadStyles(),
      ]);
      return (handle, element) => {
        addStyles(styles);
        return renderAccountBar(handle, element);
      };
    },
  },
  {
    id: "chee/sideboard",
    type: "patchwork:tool",
    tags: ["sidebar-account"],
    name: "Sideboard",
    supportedDatatypes: ["account"],
    icon: "FolderOpen",
    unlisted: true,
    async load(): Promise<ToolImplementation<SideboardAccountDoc>> {
      const [{ renderSideboard }, styles] = await Promise.all([
        import("./sideboard/sideboard.tsx"),
        loadStyles(),
      ]);
      return (handle, element) => {
        addStyles(styles);
        return renderSideboard(handle, element);
      };
    },
  },
];
