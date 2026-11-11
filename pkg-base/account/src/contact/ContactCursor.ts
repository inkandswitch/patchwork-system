import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { ToolElement } from "@inkandswitch/patchwork-plugins";
import type { ContactDoc } from "../types";

/**
 * A compact cursor token: the contact's name on a pill in their presence
 * color. Hosts that render remote cursors (text editors, canvases) mount it
 * next to their own cursor primitive (caret line, pointer arrow) via
 * `<patchwork-view doc-url={contactUrl} tool-id="contact-cursor">`.
 */
export function renderContactCursor(
  handle: DocHandle<ContactDoc>,
  element: ToolElement
) {
  const token = document.createElement("div");
  token.className = "contact-cursor-token";
  element.appendChild(token);

  function update() {
    const contact = handle.doc();
    if (!contact) {
      token.style.display = "none";
      return;
    }
    token.style.display = "";
    const name = contact.type === "registered" ? contact.name : "Anonymous";
    // The contact's chosen color; without one, the CSS fallback (neutral
    // gray) applies.
    if (contact.color) {
      token.style.setProperty("--contact-cursor-color", contact.color);
    } else {
      token.style.removeProperty("--contact-cursor-color");
    }
    token.textContent = name;
    token.title = name;
  }

  handle.on("change", update);
  update();

  return () => {
    handle.off("change", update);
    token.remove();
  };
}
