export type AvatarSize = "default" | "sm" | "lg";

const sizeClass: Record<AvatarSize, string> = {
  default: "",
  sm: "contact-avatar--sm",
  lg: "contact-avatar--lg",
};

const USER_ICON_SVGS: Record<number, string> = {
  16: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  20: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  32: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
};

export function createAvatar(size: AvatarSize = "default"): HTMLElement {
  const root = document.createElement("span");
  root.className = ["contact-avatar", sizeClass[size]]
    .filter(Boolean)
    .join(" ");
  return root;
}

export function setAvatarImage(
  root: HTMLElement,
  src: string | undefined,
  alt: string
) {
  let img = root.querySelector<HTMLImageElement>(".contact-avatar-image");
  if (src) {
    if (!img) {
      img = document.createElement("img");
      img.className = "contact-avatar-image";
      root.prepend(img);
    }
    img.src = src;
    img.alt = alt;
  } else if (img) {
    img.remove();
  }
}

export function setAvatarFallback(
  root: HTMLElement,
  content: { initials: string } | { iconSize: number }
) {
  let fallback = root.querySelector<HTMLElement>(".contact-avatar-fallback");
  if (!fallback) {
    fallback = document.createElement("span");
    fallback.className = "contact-avatar-fallback";
    root.appendChild(fallback);
  }
  if ("initials" in content) {
    fallback.textContent = content.initials;
  } else {
    fallback.innerHTML = USER_ICON_SVGS[content.iconSize] ?? USER_ICON_SVGS[20];
  }
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .join("");
}
