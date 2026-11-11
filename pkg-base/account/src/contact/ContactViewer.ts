import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { ToolElement } from "@inkandswitch/patchwork-plugins";
import type { ContactDoc } from "../types";
import { createAvatar, setAvatarImage, setAvatarFallback, getInitials } from "./Avatar";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";

export function renderContactViewer(
  handle: DocHandle<ContactDoc>,
  element: ToolElement
) {
  const wrapper = document.createElement("div");
  wrapper.className = "contact-viewer";

  const avatar = createAvatar("lg");
  const nameEl = document.createElement("h2");
  nameEl.className = "contact-viewer-name";
  const labelEl = document.createElement("p");
  labelEl.className = "contact-viewer-label";
  labelEl.textContent = "Unregistered user";

  wrapper.append(avatar, nameEl);
  element.appendChild(wrapper);

  async function update() {
    const contact = handle.doc();
    if (!contact) {
      wrapper.style.display = "none";
      return;
    }
    wrapper.style.display = "";

    const isRegistered = contact.type === "registered";
    const name = isRegistered ? contact.name : "Anonymous";

    nameEl.textContent = name;

    // avatar image
    let avatarImgUrl: string | undefined;
    if (isRegistered && contact.avatarUrl) {
      try {
        const avatarHandle = await element.repo.find(contact.avatarUrl);
        avatarImgUrl = automergeUrlToServiceWorkerUrl(avatarHandle.url);
      } catch {
        // ignore failed avatar lookup
      }
    }
    setAvatarImage(avatar, avatarImgUrl, name);

    // fallback
    if (isRegistered && name) {
      setAvatarFallback(avatar, { initials: getInitials(name) });
    } else {
      setAvatarFallback(avatar, { iconSize: 32 });
    }

    // label
    if (!isRegistered) {
      if (!wrapper.contains(labelEl)) wrapper.appendChild(labelEl);
    } else {
      labelEl.remove();
    }
  }

  handle.on("change", update);
  update();

  return () => {
    handle.off("change", update);
  };
}
