import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";

import "./main.css";

function addStyles(textContent: string, element: HTMLElement = document.head) {
  const id = "tldraw5-styles";
  const el = element.querySelector(`#${id}`) ?? document.createElement("style");
  Object.assign(el, { textContent, id });
  element.append(el);
}

async function loadStyles() {
  const url = new URL("./main.css", import.meta.url);
  return (await fetch(url)).text();
}

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "tldraw5",
    name: "tldraw",
    icon: "PenLine",
    async load() {
      return (await import("./datatype.ts")).datatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "tldraw5",
    name: "tldraw",
    // tldraw4 is listed so a v4 document can be opened here and offered the
    // one-way migration (see `migrate.tsx`).
    supportedDatatypes: ["tldraw5", "tldraw4"],
    async load(): Promise<ToolImplementation> {
      const { render } = await import("./tool.tsx");
      const styles = await loadStyles();
      return (handle, element) => {
        addStyles(styles);
        return render(handle, element);
      };
    },
  },
];
