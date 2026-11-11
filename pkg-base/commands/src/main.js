import styles from "./main.css";
import { initCommands } from "./commands.js";
import { createCommandPalette } from "./CommandPalette.js";

export const plugins = [
  {
    type: "patchwork:tool",
    id: "orion/commands",
    name: "Commands",
    supportedDatatypes: [],
    async load() {
      // HACK because we have no real solution for this kind of tool yet...
      setTimeout(() => {
        initCommands(window.accountDocHandle, window.repo);
      }, 1000);

      const container = document.createElement("div");
      container.id = "command-palette-root";
      document.body.appendChild(container);
      const shadowRoot = container.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
      shadowRoot.adoptedStyleSheets ??= [];
      shadowRoot.adoptedStyleSheets.push(sheet);

      createCommandPalette(shadowRoot);

      return () => {
        return () => {};
      };
    },
  },
];
