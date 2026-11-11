import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-comments-provider",
    name: "Comments Provider",
    async load() {
      const { CommentsProvider } = await import("./CommentsProvider.js");
      return CommentsProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-focus-provider",
    name: "Focus Provider",
    async load() {
      const { FocusProvider } = await import("./FocusProvider.js");
      return FocusProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-account-provider",
    name: "Account Provider",
    async load() {
      const { AccountProvider } = await import("./AccountProvider.js");
      return AccountProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-selected-doc-provider",
    name: "Selected Doc Provider",
    async load() {
      const { SelectedDocProvider } = await import("./SelectedDocProvider.js");
      return SelectedDocProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-tool-storage-provider",
    name: "Tool Storage Provider",
    async load() {
      const { ToolStorageProvider } = await import("./ToolStorageProvider.js");
      return ToolStorageProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-worker-provider",
    name: "Worker Provider",
    async load() {
      const { WorkerProvider } = await import("./WorkerProvider.js");
      return WorkerProvider;
    },
  },
];
