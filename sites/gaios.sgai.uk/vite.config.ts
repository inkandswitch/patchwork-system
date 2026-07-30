import { defineConfig } from "vite";
import patchwork from "@inkandswitch/patchwork/vite";

export default defineConfig({
  plugins: [
    patchwork({
      storagePrefix: "gaios",
      title: "GAIOS",
      description:
        "local-first collaborative & malleable software environment",
      syncServers:
        process.env.KEYHIVE === "true"
          ? { keyhive: "keyhive" }
          : undefined,
      themeColor: { light: "#ffffff", dark: "#ffffff" },
      icons: { source: "public/gaios.png" },
    }),
  ],
});
