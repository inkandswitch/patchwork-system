// A canvas tool: a click puts a dot on the canvas. The canvas never takes
// focus, so Cmd/Ctrl+Z reaches the history because the canvas is the element the
// user used last.
import { undoFor } from "@inkandswitch/patchwork-undo";

export function mountCanvas(handle, element) {
  const canvas = document.createElement("canvas");
  canvas.className = "undo-example-canvas";
  canvas.width = 300;
  canvas.height = 200;
  element.append(canvas);

  const undo = undoFor(element, handle);

  const draw = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const { x, y } of handle.doc().dots ?? []) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  };
  const onPointerDown = (event) => {
    const box = canvas.getBoundingClientRect();
    handle.change((doc) => {
      doc.dots ??= [];
      doc.dots.push({
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    });
    // Each click is a step of its own.
    undo.checkpoint();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  handle.on("change", draw);
  draw();

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    handle.off("change", draw);
    undo.dispose();
    canvas.remove();
  };
}

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "undo-example-canvas",
    name: "Undo example: canvas",
    async load() {
      return { init: (doc) => (doc.dots = []), getTitle: () => "Canvas" };
    },
  },
  {
    type: "patchwork:tool",
    id: "undo-example-canvas",
    name: "Canvas (undo example)",
    supportedDatatypes: ["undo-example-canvas"],
    async load() {
      return (handle, element) => mountCanvas(handle, element);
    },
  },
];
