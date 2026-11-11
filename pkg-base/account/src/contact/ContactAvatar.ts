import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim";
import type { ToolElement } from "@inkandswitch/patchwork-plugins";
import type { ContactDoc } from "../types";
import { createAvatar, setAvatarImage, setAvatarFallback, getInitials } from "./Avatar";
import { getImportableUrlFromAutomergeUrl } from "@inkandswitch/patchwork-filesystem";
import { subscribe } from "@inkandswitch/patchwork-providers";

declare global {
  interface Window {
    accountDocHandle?: { url: AutomergeUrl };
  }
}

type TinyPatchworkLayoutDoc = {
  contactUrl: AutomergeUrl;
};

export function renderContactAvatar(
  handle: DocHandle<ContactDoc>,
  element: ToolElement
) {
  const avatar = createAvatar("default");
  element.appendChild(avatar);

  let selfName = "me";
  const cleanups: (() => void)[] = [];

  // Track presence via ephemeral messages
  const heartbeats: Record<string, number> = {};
  let presenceTimer: ReturnType<typeof setInterval>;

  function onEphemeralMessage(message: { senderId: string; message: unknown }) {
    // useRemoteAwareness tracks heartbeats from ephemeral messages
    if (message.senderId) {
      heartbeats[message.senderId] = Date.now();
    }
    updatePresence();
  }

  function updatePresence() {
    const now = Date.now();
    const timeout = 30000;
    const isPresent = Object.entries(heartbeats).some(
      ([id, ts]) => id !== selfName && now - ts < timeout
    );

    // The contact's chosen color; without one, the CSS fallback (neutral
    // gray) applies.
    const userColor = handle.doc()?.color;

    if (isPresent) {
      avatar.classList.add("contact-avatar--present");
      if (userColor) {
        avatar.style.setProperty("--contact-presence-color", userColor);
      } else {
        avatar.style.removeProperty("--contact-presence-color");
      }
    } else {
      avatar.classList.remove("contact-avatar--present");
      avatar.style.removeProperty("--contact-presence-color");
    }
  }

  handle.on("ephemeral-message", onEphemeralMessage);
  cleanups.push(() => handle.off("ephemeral-message", onEphemeralMessage));

  // Periodically clean up stale heartbeats
  presenceTimer = setInterval(updatePresence, 5000);
  cleanups.push(() => clearInterval(presenceTimer));

  // Get own contact via provider subscription
  const unsubscribe = subscribe<string>(
    element,
    { type: "patchwork:contact" },
    (contactUrl) => {
      element.repo
        .find<ContactDoc>(contactUrl as AutomergeUrl)
        .then((selfHandle) => {
          const selfDoc = selfHandle.doc();
          if (selfDoc?.type === "registered") {
            selfName = selfDoc.name;
          }
        });
    }
  );
  cleanups.push(unsubscribe);

  // Fallback: use window.accountDocHandle
  if (window.accountDocHandle) {
    element.repo
      .find<TinyPatchworkLayoutDoc>(window.accountDocHandle.url)
      .then((accountHandle) => {
        const accountDoc = accountHandle.doc();
        if (accountDoc?.contactUrl) {
          element.repo
            .find<ContactDoc>(accountDoc.contactUrl)
            .then((selfHandle) => {
              const selfDoc = selfHandle.doc();
              if (selfDoc?.type === "registered") {
                selfName = selfDoc.name;
              }
            });
        }
      });
  }

  async function update() {
    const contact = handle.doc();
    if (!contact) {
      avatar.style.display = "none";
      return;
    }
    avatar.style.display = "";

    const isRegistered = contact.type === "registered";
    const name = isRegistered ? contact.name : "Anonymous";

    // avatar image
    let avatarImgUrl: string | undefined;
    if (isRegistered && contact.avatarUrl) {
      try {
        const avatarHandle = await element.repo.find(contact.avatarUrl);
        avatarImgUrl = getImportableUrlFromAutomergeUrl(avatarHandle.url);
      } catch {
        // ignore failed avatar lookup
      }
    }
    setAvatarImage(avatar, avatarImgUrl, name);

    // fallback
    if (isRegistered && name) {
      setAvatarFallback(avatar, { initials: getInitials(name) });
    } else {
      setAvatarFallback(avatar, { iconSize: 20 });
    }

    updatePresence();
  }

  handle.on("change", update);
  cleanups.push(() => handle.off("change", update));
  update();

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
