// Host UI: undo and redo buttons for the document the user used last,
// through the `patchwork:undo` provider. Works for tools in any realm the
// provider can reach; it never touches a history itself.
import { watchUndo } from "@inkandswitch/patchwork-undo";

export function mountEditMenu(element) {
  const undoButton = document.createElement("button");
  undoButton.className = "undo-example-undo";
  undoButton.textContent = "Undo";
  const redoButton = document.createElement("button");
  redoButton.className = "undo-example-redo";
  redoButton.textContent = "Redo";

  const watch = watchUndo(element, undefined, ({ canUndo, canRedo }) => {
    undoButton.disabled = !canUndo;
    redoButton.disabled = !canRedo;
  });
  // Keep the focus (and so "the document used last") where it was.
  for (const button of [undoButton, redoButton]) {
    button.onpointerdown = (event) => event.preventDefault();
  }
  undoButton.onclick = () => watch.undo();
  redoButton.onclick = () => watch.redo();
  element.append(undoButton, redoButton);

  return () => {
    watch.close();
    undoButton.remove();
    redoButton.remove();
  };
}
