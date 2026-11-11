import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { ToolElement } from "@inkandswitch/patchwork-plugins";
import type { ContactDoc } from "../types";
import { createAvatar, setAvatarImage, setAvatarFallback, getInitials } from "./Avatar";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";

export function renderInlineContactAvatar(
  handle: DocHandle<ContactDoc>,
  element: ToolElement
) {
  const avatar = createAvatar("sm");
  element.appendChild(avatar);

  async function update() {
    const contact = handle.doc();
    if (!contact) {
      avatar.style.display = "none";
      return;
    }
    avatar.style.display = "";

    const isRegistered = contact.type === "registered";
    const name = isRegistered ? contact.name : "Anonymous";
    avatar.title = name;

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
      setAvatarFallback(avatar, { iconSize: 16 });
    }
  }

  handle.on("change", update);
  update();

  return () => {
    handle.off("change", update);
  };
}
