import { isValidAutomergeUrl } from "@automerge/automerge-repo";

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "counter",
    name: "Counter",
    async load() {
      return {
        init(doc) {
          if (typeof window !== "undefined") {
            throw new Error("counter datatype init should run in a worker");
          }
          if (typeof isValidAutomergeUrl !== "function") {
            throw new Error("counter datatype worker import map is missing");
          }
          doc.count = 0;
        },
        getTitle: () => "Counter",
      };
    },
  },
  {
    type: "patchwork:tool",
    id: "counter-viewer",
    name: "Counter Viewer",
    supportedDatatypes: ["counter"],
    async load() {
      return (handle, element) => {
        const root = document.createElement("div");
        root.className = "e2e-counter";
        const count = document.createElement("output");
        count.className = "e2e-counter__count";
        const button = document.createElement("button");
        button.className = "e2e-counter__increment";
        button.textContent = "increment";
        button.onclick = () => {
          handle.change((doc) => {
            doc.count = (doc.count ?? 0) + 1;
          });
        };
        const render = () => {
          count.textContent = String(handle.doc()?.count ?? 0);
        };
        handle.on("change", render);
        render();
        root.append(count, button);
        element.append(root);
        return () => handle.off("change", render);
      };
    },
  },
];
