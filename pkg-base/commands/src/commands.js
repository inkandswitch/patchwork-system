import {
  encodeHeads,
  isValidAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";
import { Automerge } from "@automerge/automerge-repo/slim";

const toCamelCase = (str) => {
  return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
};

export const commands = (accountDocHandle, repo) => [
  {
    id: "set-sidebar-tool-id",
    label: "Set Sidebar Tool ID",
    description: "Change the sidebar to a specific tool by ID",
    category: "Layout",
    action: (sidebarToolId) => {
      accountDocHandle.change((doc) => {
        doc.accountSidebarToolId = sidebarToolId;
      });
    },
    args: [
      {
        name: "Tool ID",
        placeholder: "e.g. simple-sidebar, funky-sidebar",
        description: "The ID of the tool to display in the sidebar",
      },
    ],
  },
  {
    id: "add-context-inspector",
    label: "Add Context Inspector",
    description: "Add a context inspector to the sidebar",
    category: "Tools",
    action: async () => {
      accountDocHandle.change((doc) => {
        doc.contextToolIds.push("context-inspector");
      });
    },
  },
  {
    id: "install-module",
    label: "Install Module",
    description: "Install a module from an Automerge URL",
    category: "Tools",
    action: async (url) => {
      if (!isValidAutomergeUrl(url)) {
        throw new Error("Invalid URL");
      }

      const moduleDocHandle = await repo.find(url);
      if (!moduleDocHandle) {
        throw new Error("Module not found");
      }

      const moduleSettingsUrl = accountDocHandle.doc().moduleSettingsUrl;
      if (!moduleSettingsUrl) {
        throw new Error(
          "account has no moduleSettingsUrl yet; try again after the frame has finished mounting"
        );
      }
      const moduleSettingsHandle = await repo.find(moduleSettingsUrl);

      moduleSettingsHandle.change((doc) => {
        const doesModuleAlreadyExist = doc.modules.includes(url);
        if (doesModuleAlreadyExist) {
          console.log("Module already installed, skipping");
          return;
        } else {
          console.log("Installed module", url);
        }

        doc.modules.push(url);
      });
    },
    args: [
      {
        name: "Module URL",
        placeholder: "automerge:...",
        description: "The Automerge URL of the module to install",
      },
    ],
  },
  {
    id: "copy-current-doc",
    label: "Copy Current Document",
    description: "Create a copy of the currently open document",
    category: "Document",
    action: async () => {
      const currentDocHandle = window.currentDocHandle;
      const repo = window.repo;
      const accountDoc = window.accountDocHandle;
      if (!currentDocHandle || !accountDoc) {
        return;
      }

      const rootFolderUrl = accountDoc.doc().rootFolderUrl;
      if (!rootFolderUrl) {
        console.log(
          "account has no rootFolderUrl yet; frame should lazy-create it on mount"
        );
        return;
      }
      const rootFolderDocHandle = await repo.find(rootFolderUrl);

      const originalDocLink = rootFolderDocHandle
        .doc()
        .docs.find((doc) => doc.url === currentDocHandle.url);
      if (!originalDocLink) {
        console.log("can only copy docs that are in the root folder");
        return;
      }

      const copyDocHandle = await repo.create2();

      copyDocHandle.update(() => {
        return Automerge.clone(currentDocHandle.doc());
      });

      copyDocHandle.change((doc) => {
        const heads = encodeHeads(Automerge.getHeads(currentDocHandle.doc()));

        doc["@patchwork"].copyOf = stringifyAutomergeUrl({
          documentId: currentDocHandle.documentId,
          heads,
        });
      });

      currentDocHandle.change((doc) => {
        if (!doc["@patchwork"].copies) {
          doc["@patchwork"].copies = [];
        }

        doc["@patchwork"].copies.push(copyDocHandle.url);
      });

      rootFolderDocHandle.change((doc) => {
        doc.docs.push({
          name: originalDocLink.name,
          type: originalDocLink.type,
          url: copyDocHandle.url,
        });
      });
    },
  },
];

export const initCommands = (accountDocHandle, repo) => {
  const commandList = commands(accountDocHandle, repo);

  window.commands = commandList;
  window.$command = Object.fromEntries(
    commandList.map((cmd) => [toCamelCase(cmd.id), cmd.action])
  );
};
