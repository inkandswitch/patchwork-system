import type { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "frame-configurator",
    name: "Frame Configurator",
    icon: "Settings",
    supportedDatatypes: ["account"],
    async load(): Promise<ToolImplementation> {
      const { renderFrameConfigurator } = await import("./FrameConfigurator");
      return renderFrameConfigurator;
    },
  },
];
